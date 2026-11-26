import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { methods, type ContentBlock, type RequestPermissionRequest, type RequestPermissionResponse, type SessionNotification, type ToolCallUpdate } from "@agentclientprotocol/sdk";
import type { AiSessionModelSelection, AiSessionPermissionMode, AiSessionReasoningEffort, AiSessionStatus, AiSessionTimelineItem } from "@task-handoff/protocol/ai-sessions";
import { connectAcp, type AcpLaunch } from "./acp-connection";
import { mergeAcpToolSnapshot, projectAcpToolActivity, type AcpToolSnapshot } from "./acp-timeline";
import { appendAttachmentPaths, materializeAiSessionAttachments } from "./ai-session-attachments";
import {
  acpModelOption, acpModelValue, acpModelValueSelectable, acpPermissionModeForId, acpPermissionModeId,
  acpReasoningEffortValue, normalizeAcpSessionConfiguration, normalizeAcpSessionModes,
  type AcpSessionConfiguration, type AcpSessionModes,
} from "./acp-model";
import { aiSessionControlError, type AiSessionApprovalDecision, type AiSessionControlProvider, type AiSessionProviderCreateInput, type AiSessionProviderTimelineItemListener, type AiSessionSendInput } from "./ai-session-control";
import type { AiSessionRegistry } from "./ai-session-registry";
import { AiSessionTimelineStore } from "./ai-session/timeline-store";

type Connection = Awaited<ReturnType<typeof connectAcp>>;
type Turn = { id: string; localId: string; itemId: string; text: string; segment: string; sequence: number; tools: Map<string, AcpToolSnapshot>; done: Promise<boolean>; cancelling: boolean; approval?: PendingApproval };
type PendingApproval = { id: string; options: RequestPermissionRequest["options"]; respond: (result: RequestPermissionResponse) => void };
type Binding = {
  connection?: Connection;
  providerId?: string;
  turn?: Turn;
  starting?: boolean;
  configuration?: AcpSessionConfiguration;
  modes?: AcpSessionModes;
  permissionMode?: AiSessionPermissionMode;
  modelSelection?: AiSessionModelSelection;
  reasoningEffort?: AiSessionReasoningEffort;
  cleanupDir?: string;
  persistSessionHome?: AcpLaunch["persistSessionHome"];
};
export type AcpLaunchInput = {
  cwd: string;
  providerSessionId?: string;
  permissionMode?: AiSessionPermissionMode;
  modelSelection?: AiSessionModelSelection;
  reasoningEffort?: AiSessionReasoningEffort;
};
export type AcpSessionProviderOptions = {
  /** Provider-private, restart-persistent Story instruction snapshot path. */
  instructionSnapshotPath?: string;
};
type MessageDelta = { sessionId: string; providerSessionId: string; turnId: string; itemId: string; delta: string };
type ReplayTurn = { user: string; assistant: string; responding: boolean; hasTools: boolean };

const cancelled = (): RequestPermissionResponse => ({ outcome: { outcome: "cancelled" } });

export function invalidateAcpSession(registry: AiSessionRegistry, session: AiSessionStatus) {
  const active = session.status === "running" || session.status === "waiting";
  if (active) registry.applyRealtimeEvent(session.id, {
    kind: "turn-completed", activeTurnId: session.activeTurnId, status: "failed", phase: "unknown",
    error: "The ACP Agent disconnected before confirming the prompt outcome.",
  });
  registry.patch(session.id, { actions: { send: false, interrupt: false, approval: false, close: true, openApp: false } });
}

export class AcpSessionProvider implements AiSessionControlProvider {
  readonly closeDetachesProviderSession = true;
  private readonly sessions = new Map<string, Binding>();
  private readonly starting = new Set<Promise<unknown>>();
  private readonly timelineListeners = new Set<AiSessionProviderTimelineItemListener>();
  private readonly instructionBySession = new Map<string, string>();
  private generation = 0;

  constructor(
    readonly agent: string,
    private readonly registry: AiSessionRegistry,
    private readonly launch: (input: AcpLaunchInput) => AcpLaunch | Promise<AcpLaunch>,
    private readonly onMessageDelta: (event: MessageDelta) => void,
    private readonly timelineStore: AiSessionTimelineStore,
    private negotiatedLoadSession?: boolean,
    private readonly options: AcpSessionProviderOptions = {},
  ) {
    this.restoreInstructionSnapshots();
  }

  get historyResume() {
    return this.negotiatedLoadSession === true;
  }

  async createSession(input: AiSessionProviderCreateInput) {
    return this.open(input.cwd, undefined, input.permissionMode, input.modelSelection, input.reasoningEffort, input.appendedPrompt);
  }

  async restore(providerSessionId: string, cwd: string, modelSelection?: AiSessionModelSelection, reasoningEffort?: AiSessionReasoningEffort) {
    if (this.sessions.has(providerSessionId)) return modelSelection;
    if (!cwd) throw aiSessionControlError("AI_SESSION_RESUME_UNAVAILABLE", "The ACP session has no workspace.", 409);
    const result = await this.open(cwd, providerSessionId, undefined, modelSelection, reasoningEffort, this.instructionBySession.get(providerSessionId));
    const session = this.registry.getByProviderSessionId(this.agent, providerSessionId);
    if (session) this.markSessionActions(session);
    return result.modelSelection;
  }

  private async open(cwd: string, providerSessionId?: string, permissionMode?: AiSessionPermissionMode, modelSelection?: AiSessionModelSelection, reasoningEffort?: AiSessionReasoningEffort, appendedPrompt?: string) {
    const operation = this.connectSession(cwd, this.generation, providerSessionId, permissionMode, modelSelection, reasoningEffort, appendedPrompt);
    this.starting.add(operation);
    try {
      return await operation;
    } finally {
      this.starting.delete(operation);
    }
  }

  private async connectSession(cwd: string, generation: number, providerSessionId?: string, permissionMode?: AiSessionPermissionMode, modelSelection?: AiSessionModelSelection, reasoningEffort?: AiSessionReasoningEffort, appendedPrompt?: string) {
    const binding: Binding = {};
    const replay = providerSessionId ? new AcpReplay() : undefined;
    try {
      const launch = await this.launch({ cwd, providerSessionId, permissionMode, modelSelection, reasoningEffort });
      binding.cleanupDir = launch.cleanupDir;
      binding.persistSessionHome = launch.persistSessionHome;
      const connection = await connectAcp(launch, cwd, {
        update: (event) => {
          if (replay && !binding.providerId) {
            if (event.sessionId === providerSessionId) replay.update(event.update);
          } else this.update(binding, event);
        },
        permission: (request) => this.permission(binding, request),
      });
      binding.connection = connection;
      if (generation !== this.generation) throw new Error("The ACP provider was stopped while opening a session.");
      this.negotiatedLoadSession = connection.capabilities?.loadSession === true;
      const timeout = {
        cancellationSignal: AbortSignal.timeout(15_000), stopWaitingOnCancel: true,
      };
      let sessionId: string;
      let opened: unknown;
      const systemPromptSupported = Boolean(connection.capabilities?.sessionCapabilities?.systemPrompt);
      if (appendedPrompt && !systemPromptSupported) {
        throw aiSessionControlError(
          "AI_SESSION_STORY_CONTEXT_UNSUPPORTED",
          `${this.agent} does not advertise ACP sessionCapabilities.systemPrompt.`,
          409,
        );
      }
      const systemPrompt = appendedPrompt && systemPromptSupported
        ? { mode: "append" as const, content: [{ type: "text" as const, text: appendedPrompt }] }
        : undefined;
      if (providerSessionId) {
        if (!connection.capabilities?.loadSession) throw new Error("The Agent does not support ACP session/load.");
        opened = await connection.agent.request(methods.agent.session.load, {
          sessionId: providerSessionId, cwd, mcpServers: [],
          ...(systemPrompt ? { systemPrompt } : {}),
        }, timeout);
        sessionId = providerSessionId;
      } else {
        const created = await connection.agent.request(methods.agent.session.new, {
          cwd, mcpServers: [],
          ...(systemPrompt ? { systemPrompt } : {}),
        }, timeout) as { sessionId: string };
        sessionId = created.sessionId;
        opened = created;
      }
      if (generation !== this.generation) throw new Error("The ACP provider was stopped while opening a session.");
      if (!sessionId.trim() || sessionId.trim() !== sessionId || sessionId.length > 240 || this.sessions.has(sessionId)) {
        throw new Error("Agent returned an invalid or already active session ID.");
      }
      replay?.reconcile(this.timelineStore, sessionId);
      if (appendedPrompt) {
        this.instructionBySession.set(sessionId, appendedPrompt);
        this.persistInstructionSnapshots();
      }
      binding.providerId = sessionId;
      binding.configuration = normalizeAcpSessionConfiguration(opened);
      binding.modes = normalizeAcpSessionModes((opened as { modes?: unknown } | undefined)?.modes);
      if (!binding.configuration.options.length && !binding.configuration.legacyModels) {
        binding.configuration = await this.readSessionConfiguration(connection, sessionId, timeout);
      }
      if (permissionMode) {
        await this.applyPermissionMode(binding, sessionId, permissionMode, timeout);
      }
      if (modelSelection) {
        await this.applyModelSelection(binding, sessionId, modelSelection, timeout);
      }
      if (reasoningEffort) {
        await this.applyReasoningEffort(binding, sessionId, reasoningEffort, timeout);
      }
      this.sessions.set(sessionId, binding);
      void connection.closed.then(async () => {
        if (binding.turn) this.settleApproval(binding.turn, cancelled());
        await binding.turn?.done.catch(() => {});
        if (this.sessions.get(sessionId) === binding) {
          this.sessions.delete(sessionId);
          const session = this.registry.getByProviderSessionId(this.agent, sessionId);
          if (session) invalidateAcpSession(this.registry, session);
        }
        await connection.close();
        await this.cleanup(binding);
      }).catch(() => {});
      return {
        providerSessionId: sessionId,
        cwd,
        creationSource: "ai-session" as const,
        ...(binding.modelSelection ? { modelSelection: binding.modelSelection } : {}),
        ...(binding.reasoningEffort ? { reasoningEffort: binding.reasoningEffort } : {}),
      };
    } catch (error) {
      await binding.connection?.close();
      await this.cleanup(binding);
      if ((error as { code?: unknown } | undefined)?.code === "AI_SESSION_STORY_CONTEXT_UNSUPPORTED") throw error;
      throw aiSessionControlError(providerSessionId ? "AI_SESSION_RESUME_UNAVAILABLE" : "AI_SESSION_PROVIDER_UNAVAILABLE", `${this.agent}: ${this.errorText(error)}`, 409);
    }
  }

  async startMessage(session: AiSessionStatus, input: AiSessionSendInput) {
    session = this.markSessionActions(session);
    const binding = this.requireBinding(session);
    if (binding.turn || binding.starting) throw aiSessionControlError("AI_SESSION_TURN_IN_PROGRESS", "A turn is already in progress.", 409);
    binding.starting = true;
    try {
      if (input.permissionMode) {
        await this.applyPermissionMode(binding, binding.providerId!, input.permissionMode, {
          cancellationSignal: AbortSignal.timeout(15_000), stopWaitingOnCancel: true,
        });
      }
      const prompt = this.prompt(input, session.cwd, binding.connection?.capabilities?.promptCapabilities?.image === true);
      const id = input.messageId || `msg_${randomUUID()}`;
      const turn: Turn = { id, localId: session.id, itemId: `${id.slice(0, 210)}:assistant:0`, text: "", segment: "", sequence: 0, tools: new Map(), done: Promise.resolve(false), cancelling: false };
      const updated = this.registry.applyRealtimeEvent(session.id, {
        kind: "send-ack", activeTurnId: id, providerTurnId: id, userPrompt: input.message,
        userMessage: { id, text: input.message, attachments: input.userMessageAttachments || [] }, status: "running", phase: "thinking",
      }, { persistence: "strict" }) || session;
      binding.turn = turn;
      this.publishItem(binding, turn, {
        type: "user-message", id, turnId: id, text: input.message,
        ...(input.userMessageAttachments?.length ? { attachments: input.userMessageAttachments } : {}),
      });
      turn.done = this.runPrompt(binding, turn, prompt);
      void turn.done.catch(() => {});
      return { session: updated, provider: this.agent, action: "send" as const, turnId: id, providerTurnId: id };
    } finally {
      binding.starting = false;
    }
  }

  async renameSession(session: AiSessionStatus, title: string) {
    const normalized = title.trim();
    const updated = this.registry.patch(session.id, { title: normalized || undefined });
    if (!updated) throw aiSessionControlError("AI_SESSION_NOT_FOUND", "AI session not found.", 404);
    return { title: normalized, authority: "adapter" as const };
  }

  async interrupt(session: AiSessionStatus) {
    const binding = this.requireBinding(session);
    const turn = binding.turn;
    if (turn) {
      if (!turn.cancelling) {
        turn.cancelling = true;
        this.settleApproval(turn, cancelled());
        await binding.connection!.agent.notify(methods.agent.session.cancel, { sessionId: binding.providerId! }).catch(() => {
          throw this.cancelDisconnected();
        });
      }
      const deadline = AbortSignal.timeout(10_000);
      const completed = await Promise.race([turn.done, new Promise<undefined>((resolve) => deadline.addEventListener("abort", () => resolve(undefined), { once: true }))]);
      if (completed === undefined) {
        await binding.connection!.close();
        throw aiSessionControlError("AI_SESSION_CANCEL_TIMEOUT", "The ACP Agent did not confirm cancellation.", 504);
      }
      if (!completed) throw this.cancelDisconnected();
    }
    return { session: this.registry.get(session.id) || session, provider: this.agent, action: "interrupt" as const, turnId: turn?.id, providerTurnId: turn?.id };
  }

  async updateModelSelection(session: AiSessionStatus, selection: AiSessionModelSelection) {
    const binding = this.requireBinding(session);
    if (binding.turn) throw aiSessionControlError("AI_SESSION_MODEL_SELECTION_CONFLICT", "The model cannot be changed while a turn is active.", 409);
    const previousEntityId = binding.modelSelection?.modelEntityId ?? session.modelSelection?.modelEntityId;
    if (this.agent === "gemini" && previousEntityId && previousEntityId !== selection.modelEntityId) {
      throw aiSessionControlError(
        "AI_SESSION_MODEL_SELECTION_UNSUPPORTED",
        "Gemini requires a new session to change the configured model provider.",
        409,
      );
    }
    await this.applyModelSelection(binding, binding.providerId!, selection, {
      cancellationSignal: AbortSignal.timeout(15_000), stopWaitingOnCancel: true,
    });
    const actualSelection = binding.modelSelection ?? selection;
    this.registry.applyRealtimeEvent(session.id, {
      kind: "model-selection",
      modelSelection: actualSelection,
      observedAt: new Date().toISOString(),
    }, { persistence: "strict" });
    return actualSelection;
  }

  async updateReasoningEffort(session: AiSessionStatus, effort: AiSessionReasoningEffort) {
    const binding = this.requireBinding(session);
    if (binding.turn) throw aiSessionControlError("AI_SESSION_REASONING_EFFORT_CONFLICT", "Reasoning effort cannot be changed while a turn is active.", 409);
    await this.applyReasoningEffort(binding, binding.providerId!, effort, {
      cancellationSignal: AbortSignal.timeout(15_000), stopWaitingOnCancel: true,
    });
    const actualEffort = binding.reasoningEffort ?? effort;
    this.registry.applyRealtimeEvent(session.id, {
      kind: "reasoning-effort",
      reasoningEffort: actualEffort,
      observedAt: new Date().toISOString(),
    }, { persistence: "strict" });
    return actualEffort;
  }

  async resolveApproval(session: AiSessionStatus, decision: AiSessionApprovalDecision, approvalRequestId?: string) {
    const turn = this.requireBinding(session).turn;
    if (!turn?.approval) throw aiSessionControlError("AI_SESSION_APPROVAL_NOT_FOUND", "No ACP approval is pending.", 404);
    if (turn.approval.id !== approvalRequestId) throw aiSessionControlError("AI_SESSION_APPROVAL_STALE", "The approval is no longer current.", 409);
    const option = turn.approval.options.find(({ kind }) => kind === (decision === "allow" ? "allow_once" : "reject_once"));
    if (decision === "skip" || !option) throw aiSessionControlError("AI_SESSION_APPROVAL_UNSUPPORTED", "The Agent did not offer that decision.", 409);
    const updated = this.registry.applyRealtimeEvent(session.id, { kind: "lifecycle", status: "running", phase: "thinking" }, { persistence: "strict" }) || session;
    this.settleApproval(turn, { outcome: { outcome: "selected", optionId: option.optionId } });
    return { session: updated, provider: this.agent, action: "approval" as const, decision };
  }

  async unsubscribeSession(providerSessionId: string) {
    const binding = this.sessions.get(providerSessionId);
    if (!binding) return;
    this.sessions.delete(providerSessionId);
    if (binding.turn) this.settleApproval(binding.turn, cancelled());
    await binding.connection?.close();
    await this.cleanup(binding);
    const session = this.registry.getByProviderSessionId(this.agent, providerSessionId);
    if (session && !this.sessions.has(providerSessionId)) invalidateAcpSession(this.registry, session);
  }

  async close() {
    this.generation += 1;
    await Promise.allSettled([...this.starting, ...[...this.sessions.keys()].map((id) => this.unsubscribeSession(id))]);
  }

  private restoreInstructionSnapshots() {
    const filePath = this.options.instructionSnapshotPath;
    if (!filePath || !existsSync(filePath)) return;
    try {
      const raw = JSON.parse(readFileSync(filePath, "utf8")) as { version?: unknown; sessions?: unknown };
      if (raw.version !== 1 || !raw.sessions || typeof raw.sessions !== "object" || Array.isArray(raw.sessions)) {
        throw new Error("Unsupported ACP Story instruction snapshot.");
      }
      for (const [providerSessionId, instruction] of Object.entries(raw.sessions)) {
        if (providerSessionId.trim() && typeof instruction === "string" && instruction) {
          this.instructionBySession.set(providerSessionId, instruction);
        }
      }
    } catch {
      // A malformed snapshot must not prevent the provider from serving sessions.
    }
  }

  private persistInstructionSnapshots() {
    const filePath = this.options.instructionSnapshotPath;
    if (!filePath) return;
    try {
      mkdirSync(path.dirname(filePath), { recursive: true });
      const temporaryPath = `${filePath}.${process.pid}.tmp`;
      writeFileSync(temporaryPath, JSON.stringify({
        version: 1,
        sessions: Object.fromEntries(this.instructionBySession),
      }, null, 2));
      renameSync(temporaryPath, filePath);
    } catch {
      // The in-memory snapshot still serves this process; persistence is best effort.
    }
  }

  subscribeTimelineItems(listener: AiSessionProviderTimelineItemListener) {
    this.timelineListeners.add(listener);
    return () => { this.timelineListeners.delete(listener); };
  }

  async timeline(session: AiSessionStatus) {
    const providerSessionId = session.providerSessionId;
    if (!providerSessionId) throw aiSessionControlError("AI_SESSION_PROVIDER_UNAVAILABLE", "The ACP session has no provider identity.", 409);
    return { sessionId: session.id, providerSessionId, items: this.timelineStore.items(providerSessionId), generatedAt: new Date().toISOString() };
  }

  async turnTimeline(session: AiSessionStatus, turnId: string) {
    const { sessionId, items, generatedAt } = await this.timeline(session);
    return { sessionId, turnId, items: items.filter((item) => item.turnId === turnId), generatedAt };
  }

  private requireBinding(session: AiSessionStatus) {
    const binding = session.providerSessionId && this.sessions.get(session.providerSessionId);
    if (!binding) throw aiSessionControlError("AI_SESSION_PROVIDER_UNAVAILABLE", "The ACP session is not connected.", 409);
    return binding;
  }

  private markSessionActions(session: AiSessionStatus) {
    return this.registry.patch(session.id, {
      actions: {
        ...session.actions,
        send: true,
        interrupt: true,
        rename: true,
        close: true,
        openApp: false,
        fork: false,
      },
    }) || session;
  }

  private async readSessionConfiguration(connection: Connection, sessionId: string, options: { cancellationSignal?: AbortSignal; stopWaitingOnCancel?: boolean }) {
    try {
      const response = await connection.agent.request<unknown, { sessionId: string }>(
        "session/options",
        { sessionId },
        options,
      );
      return normalizeAcpSessionConfiguration(response);
    } catch {
      return { options: [] } satisfies AcpSessionConfiguration;
    }
  }

  private async applyModelSelection(
    binding: Binding,
    sessionId: string,
    selection: AiSessionModelSelection,
    options: { cancellationSignal?: AbortSignal; stopWaitingOnCancel?: boolean },
  ) {
    const connection = binding.connection;
    if (!connection) throw aiSessionControlError("AI_SESSION_PROVIDER_UNAVAILABLE", "The ACP session is not connected.", 409);
    const configuration = binding.configuration ?? { options: [] };
    const value = acpModelValue(this.agent, selection);
    if (!acpModelValueSelectable(configuration, value)) {
      throw aiSessionControlError("AI_SESSION_MODEL_TARGET_UNAVAILABLE", "The selected model is not available in this ACP Agent session.", 409);
    }
    try {
      if (configuration.legacyModels) {
        await connection.agent.request<unknown, { sessionId: string; modelId: string }>("session/set_model", { sessionId, modelId: value }, options);
        configuration.legacyModels.currentModelId = value;
      } else {
        const option = acpModelOption(configuration);
        if (!option) throw new Error("The Agent did not advertise a model configuration option.");
        const response = await connection.agent.request(methods.agent.session.setConfigOption, {
          sessionId, configId: option.id, value,
        }, options);
        binding.configuration = normalizeAcpSessionConfiguration(response);
      }
    } catch (error) {
      if (error instanceof Error && "code" in error) throw error;
      throw aiSessionControlError("AI_SESSION_MODEL_SELECTION_UNAVAILABLE", `${this.agent}: ${this.errorText(error)}`, 409);
    }
    binding.modelSelection = selection;
  }

  private async applyPermissionMode(
    binding: Binding,
    sessionId: string,
    mode: AiSessionPermissionMode,
    options: { cancellationSignal?: AbortSignal; stopWaitingOnCancel?: boolean },
  ) {
    const connection = binding.connection;
    if (!connection) throw aiSessionControlError("AI_SESSION_PROVIDER_UNAVAILABLE", "The ACP session is not connected.", 409);
    if (binding.permissionMode === mode) return;
    const modes = binding.modes;
    const modeId = acpPermissionModeId(this.agent, mode);
    if (!modeId || !modes?.availableModes.some((candidate) => candidate.id === modeId)) {
      throw aiSessionControlError(
        "AI_SESSION_PERMISSION_MODE_UNAVAILABLE",
        `${this.agent} does not offer the ${mode} permission mode.`,
        409,
      );
    }
    if (modes.currentModeId !== modeId) {
      try {
        await connection.agent.request(methods.agent.session.setMode, { sessionId, modeId }, options);
      } catch (error) {
        throw aiSessionControlError("AI_SESSION_PERMISSION_MODE_UNAVAILABLE", `${this.agent}: ${this.errorText(error)}`, 409);
      }
      modes.currentModeId = modeId;
    }
    binding.permissionMode = mode;
  }

  private async applyReasoningEffort(
    binding: Binding,
    sessionId: string,
    effort: AiSessionReasoningEffort,
    options: { cancellationSignal?: AbortSignal; stopWaitingOnCancel?: boolean },
  ) {
    const connection = binding.connection;
    if (!connection) throw aiSessionControlError("AI_SESSION_PROVIDER_UNAVAILABLE", "The ACP session is not connected.", 409);
    const configuration = binding.configuration ?? { options: [] };
    const value = acpReasoningEffortValue(configuration, effort);
    if (!value) {
      throw aiSessionControlError("AI_SESSION_REASONING_EFFORT_UNAVAILABLE", "The ACP Agent does not offer that reasoning effort.", 409);
    }
    const option = configuration.options.find((candidate) => candidate.category === "thought_level"
      || candidate.id === "reasoning_effort" || candidate.id === "effort");
    if (!option) throw aiSessionControlError("AI_SESSION_REASONING_EFFORT_UNAVAILABLE", "The ACP Agent does not expose reasoning effort.", 409);
    try {
      const response = await connection.agent.request(methods.agent.session.setConfigOption, {
        sessionId, configId: option.id, value,
      }, options);
      binding.configuration = normalizeAcpSessionConfiguration(response);
    } catch (error) {
      throw aiSessionControlError("AI_SESSION_REASONING_EFFORT_UNAVAILABLE", `${this.agent}: ${this.errorText(error)}`, 409);
    }
    binding.reasoningEffort = effort;
  }

  private async cleanup(binding: Binding) {
    const providerSessionId = binding.providerId;
    const persistSessionHome = binding.persistSessionHome;
    binding.persistSessionHome = undefined;
    if (providerSessionId && persistSessionHome) await Promise.resolve(persistSessionHome(providerSessionId)).catch(() => undefined);
    const directory = binding.cleanupDir;
    binding.cleanupDir = undefined;
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }

  private prompt(input: AiSessionSendInput, cwd: string, imageSupported: boolean) {
    const files = materializeAiSessionAttachments(input.attachments || [], cwd);
    const pathReferences: typeof files = [];
    const content: ContentBlock[] = [];
    const text = input.message.trim();
    if (text) content.push({ type: "text", text });
    for (const [index, file] of files.entries()) {
      const attachment = input.attachments![index];
      if (attachment.kind === "image" && imageSupported) {
        content.push({
          type: "image",
          data: readFileSync(file.path).toString("base64"),
          mimeType: attachment.mime,
          uri: pathToFileURL(file.path).href,
        });
        continue;
      }
      content.push({
        type: "resource_link",
        name: attachment.name,
        uri: pathToFileURL(file.path).href,
        mimeType: attachment.mime,
        size: file.size,
      });
      pathReferences.push(file);
    }
    const promptText = appendAttachmentPaths(text, pathReferences);
    if (promptText && content[0]?.type === "text") content[0] = { type: "text", text: promptText };
    else if (promptText) content.unshift({ type: "text", text: promptText });
    return { text: promptText, content };
  }

  private async runPrompt(binding: Binding, turn: Turn, prompt: { text: string; content: ContentBlock[] }) {
    let failure: string | undefined;
    let receivedOutcome = false;
    try {
      const result = await binding.connection!.agent.request(methods.agent.session.prompt, {
        sessionId: binding.providerId!, prompt: prompt.content,
      });
      receivedOutcome = true;
      if (result.stopReason === "refusal") failure = "The ACP Agent refused the prompt.";
    } catch (error) {
      failure = this.errorText(error);
    } finally {
      this.settleApproval(turn, cancelled());
      if (binding.turn === turn) binding.turn = undefined;
    }
    if (this.sessions.get(binding.providerId!) !== binding) return receivedOutcome;
    this.finishSegment(binding, turn);
    if (turn.text) this.registry.applyRealtimeEvent(turn.localId, {
      kind: "assistant-message", activeTurnId: turn.id, providerTurnId: turn.id, itemId: turn.itemId, text: turn.text,
    });
    this.registry.applyRealtimeEvent(turn.localId, {
      kind: "turn-completed", activeTurnId: turn.id, providerTurnId: turn.id, status: failure ? "failed" : "idle",
      phase: "unknown", text: turn.text, ...(failure ? { error: failure } : {}),
    });
    return receivedOutcome;
  }

  private update(binding: Binding, notification: SessionNotification) {
    const turn = binding.turn;
    const update = notification.update;
    if (notification.sessionId !== binding.providerId || this.sessions.get(notification.sessionId) !== binding) return;
    if (update.sessionUpdate === "config_option_update") {
      const current = binding.configuration?.legacyModels;
      binding.configuration = normalizeAcpSessionConfiguration({ configOptions: update.configOptions });
      if (current) binding.configuration.legacyModels = current;
      return;
    }
    if (update.sessionUpdate === "current_mode_update") {
      if (binding.modes) binding.modes.currentModeId = update.currentModeId;
      binding.permissionMode = acpPermissionModeForId(this.agent, update.currentModeId);
      return;
    }
    if (!turn || notification.sessionId !== binding.providerId || this.sessions.get(notification.sessionId) !== binding) return;
    if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
      this.projectTool(binding, turn, update);
      return;
    }
    if (update.sessionUpdate !== "agent_message_chunk" || update.content.type !== "text") return;
    if (!turn.segment && turn.text) turn.itemId = `${turn.id.slice(0, 210)}:assistant:${++turn.sequence}`;
    turn.text += update.content.text;
    turn.segment += update.content.text;
    this.onMessageDelta({ sessionId: turn.localId, providerSessionId: notification.sessionId, turnId: turn.id, itemId: turn.itemId, delta: update.content.text });
  }

  private finishSegment(binding: Binding, turn: Turn) {
    if (!turn.segment) return;
    this.publishItem(binding, turn, { type: "ai-message", id: turn.itemId, turnId: turn.id, text: turn.segment });
    turn.segment = "";
  }

  private projectTool(binding: Binding, turn: Turn, update: ToolCallUpdate) {
    this.finishSegment(binding, turn);
    const previous = turn.tools.get(update.toolCallId);
    const id = previous?.id ?? `${turn.id.slice(0, 210)}:tool:${++turn.sequence}`;
    const snapshot = mergeAcpToolSnapshot(previous, update, { id, turnId: turn.id });
    const item = projectAcpToolActivity(snapshot);
    turn.tools.set(update.toolCallId, snapshot);
    this.publishItem(binding, turn, item);
  }

  private publishItem(binding: Binding, turn: Turn, item: AiSessionTimelineItem) {
    const providerSessionId = binding.providerId!;
    this.timelineStore.upsert(providerSessionId, item);
    for (const listener of this.timelineListeners) listener({ sessionId: turn.localId, providerSessionId, item });
  }

  private permission(binding: Binding, request: RequestPermissionRequest) {
    const turn = binding.turn;
    if (!turn || turn.cancelling || turn.approval || request.sessionId !== binding.providerId || this.sessions.get(request.sessionId) !== binding
      || !request.options.some(({ kind }) => kind === "allow_once" || kind === "reject_once")) return Promise.resolve(cancelled());
    return new Promise<RequestPermissionResponse>((respond) => {
      const id = randomUUID();
      const decisions: AiSessionApprovalDecision[] = [];
      if (request.options.some(({ kind }) => kind === "allow_once")) decisions.push("allow");
      if (request.options.some(({ kind }) => kind === "reject_once")) decisions.push("deny");
      turn.approval = { id, options: request.options, respond };
      this.registry.applyRealtimeEvent(turn.localId, {
        kind: "approval-requested", activeTurnId: turn.id, providerTurnId: turn.id, status: "waiting", phase: "approval",
        summary: (request.toolCall.title || "ACP permission request").slice(0, 1000), counters: { approvals: 1 },
        approvalRequest: { id, decisions },
      });
    });
  }

  private settleApproval(turn: Turn, response: RequestPermissionResponse) {
    const pending = turn.approval;
    turn.approval = undefined;
    pending?.respond(response);
  }

  private errorText(error: unknown) {
    return (error instanceof Error ? error.message : "ACP Agent request failed.").slice(0, 4000);
  }

  private cancelDisconnected() {
    return aiSessionControlError("AI_SESSION_PROVIDER_UNAVAILABLE", "The ACP prompt ended without a confirmed outcome.", 409);
  }
}

class AcpReplay {
  private readonly turns: ReplayTurn[] = [];
  private size = 0;
  private invalid = false;

  update(update: SessionNotification["update"]) {
    if (this.invalid) return;
    let turn = this.turns.at(-1);
    if (update.sessionUpdate === "user_message_chunk" || update.sessionUpdate === "agent_message_chunk") {
      const text = update.content.type === "text" ? update.content.text : undefined;
      this.size += text?.length ?? 0;
      if (text === undefined || this.size > 4_000_000) { this.invalid = true; return; }
      if (update.sessionUpdate === "user_message_chunk") {
        if (!turn || turn.responding) {
          turn = { user: "", assistant: "", responding: false, hasTools: false };
          this.turns.push(turn);
        }
        turn.user += text;
      } else if (turn) {
        turn.assistant += text;
        turn.responding = true;
      } else this.invalid = true;
    } else if (turn && (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update")) {
      turn.responding = true;
      turn.hasTools = true;
    }
  }

  reconcile(store: AiSessionTimelineStore, sessionId: string) {
    if (this.invalid || !this.turns.length) return;
    const items = store.items(sessionId);
    const users = items.filter((item) => item.type === "user-message");
    if (users.length !== this.turns.length || users.some((item, index) => item.text !== this.turns[index].user)) return;
    const missing = new Map<string, AiSessionTimelineItem>();
    const occupiedTurns = new Set(items.filter((item) => item.type !== "user-message").map((item) => item.turnId));
    for (const [index, user] of users.entries()) {
      const turn = this.turns[index];
      if (!turn.hasTools && turn.assistant && !occupiedTurns.has(user.turnId)) {
        missing.set(user.id, { type: "ai-message", id: `${user.turnId.slice(0, 210)}:assistant:0`, turnId: user.turnId, text: turn.assistant });
      }
    }
    if (missing.size) store.replace(sessionId, items.flatMap((item) => {
      const restored = missing.get(item.id);
      return restored ? [item, restored] : [item];
    }));
  }
}
