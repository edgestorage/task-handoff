import { randomUUID } from "node:crypto";
import type {
  AiSessionActionResult,
  AiSessionApprovalInput,
  AiSessionCreationSource,
  AiSessionMessageAttachment,
  AiSessionConversationAttachment,
  AiSessionPermissionMode,
  AiSessionLineage,
  AiSessionReference,
  AiSessionSendMode,
  AiSessionStatus,
  AiSessionTimeline,
  AiSessionTimelineItem,
  AiSessionTurnTimeline,
} from "@task-handoff/protocol/ai-sessions";
import type { AiSessionTimelineCapabilities } from "@task-handoff/protocol/control-plane";
import type { AiSessionRegistry } from "./ai-session-registry";

export type AiSessionSendInput = {
  message: string;
  mode?: AiSessionSendMode;
  attachments?: AiSessionMessageAttachment[];
  references?: AiSessionReference[];
  permissionMode?: AiSessionPermissionMode;
  /** Internal controlled-instance identity; never accepted from the public wire model. */
  messageId?: string;
  userMessageAttachments?: AiSessionConversationAttachment[];
  /** Internal controlled-instance draft handles, scoped before provider dispatch. */
  draftAttachmentIds?: string[];
  draftScopeType?: "session" | "create-request";
  draftScopeId?: string;
};

export type AiSessionApprovalDecision = AiSessionApprovalInput["decision"];
export type { AiSessionActionResult } from "@task-handoff/protocol/ai-sessions";

export type AiSessionProviderCreateInput = {
  cwd: string;
  permissionMode?: AiSessionPermissionMode;
};

export type AiSessionProviderCreateResult = {
  providerSessionId: string;
  cwd: string;
  creationSource: AiSessionCreationSource;
};

export type AiSessionProviderForkInput = {
  source: AiSessionStatus;
  throughTurnId?: string;
  providerThroughTurnId?: string;
  cwd?: string;
};

export type AiSessionProviderForkResult = AiSessionProviderCreateResult & {
  lineage: AiSessionLineage;
};

export type PendingAiSessionApproval = {
  id: string;
  sessionId: string;
  provider: string;
  summary: string;
  metadata?: Record<string, unknown>;
  resolve: (decision: AiSessionApprovalDecision) => Promise<void> | void;
};

export type AiSessionProviderTimelineItemEvent = {
  sessionId: string;
  providerSessionId: string;
  item: AiSessionTimelineItem;
};

export type AiSessionProviderTimelineItemListener = (event: AiSessionProviderTimelineItemEvent) => void;

export type AiSessionProviderTimelineCapabilities = {
  sessionRead: boolean;
  turnRead: boolean;
  liveItems: boolean;
};

export interface AiSessionControlProvider {
  readonly agent: string;
  createSession?(input: AiSessionProviderCreateInput): Promise<AiSessionProviderCreateResult>;
  forkSession?(input: AiSessionProviderForkInput): Promise<AiSessionProviderForkResult>;
  readSession?(providerSessionId: string): Promise<void>;
  resumeSession?(providerSessionId: string): Promise<void>;
  archiveSession?(providerSessionId: string): Promise<void>;
  activeSessionExists?(providerSessionId: string): Promise<boolean>;
  deleteSession?(providerSessionId: string): Promise<void>;
  unsubscribeSession?(providerSessionId: string): Promise<void>;
  startMessage?(session: AiSessionStatus, input: AiSessionSendInput): Promise<AiSessionActionResult>;
  steerMessage?(session: AiSessionStatus, input: AiSessionSendInput): Promise<AiSessionActionResult>;
  sendMessage?(session: AiSessionStatus, input: AiSessionSendInput): Promise<AiSessionActionResult>;
  /** Reads an authoritative snapshot for the complete session Timeline. */
  timeline?(session: AiSessionStatus): Promise<AiSessionTimeline>;
  /** Reads one Turn independently; implementing this does not require a complete-session reader. */
  turnTimeline?(session: AiSessionStatus, turnId: string): Promise<AiSessionTurnTimeline>;
  /** Publishes authoritative single-item lifecycle updates; implementing reads does not imply this capability. */
  subscribeTimelineItems?(listener: AiSessionProviderTimelineItemListener): () => void;
  /** Reports the provider's current runtime support for each independent Timeline operation. */
  timelineCapabilities?(): AiSessionProviderTimelineCapabilities;
  interrupt(session: AiSessionStatus): Promise<AiSessionActionResult>;
  resolveApproval?(session: AiSessionStatus, decision: AiSessionApprovalDecision): Promise<AiSessionActionResult>;
}

export class PendingAiSessionApprovalStore {
  private readonly approvals = new Map<string, PendingAiSessionApproval>();

  register(approval: PendingAiSessionApproval) {
    this.approvals.set(approval.id, approval);
    return approval;
  }

  latestForSession(sessionId: string) {
    return [...this.approvals.values()].filter((approval) => approval.sessionId === sessionId).at(-1);
  }

  async resolveForSession(sessionId: string, decision: AiSessionApprovalDecision) {
    const approval = this.latestForSession(sessionId);
    if (!approval) {
      return undefined;
    }
    await approval.resolve(decision);
    this.approvals.delete(approval.id);
    return approval;
  }

  remove(id: string) {
    return this.approvals.delete(id);
  }

  clearSession(sessionId: string) {
    for (const approval of this.approvals.values()) {
      if (approval.sessionId === sessionId) {
        this.approvals.delete(approval.id);
      }
    }
  }

  clear() {
    this.approvals.clear();
  }
}

export class AiSessionController {
  private readonly providers = new Map<string, AiSessionControlProvider>();
  private readonly timelineItemListeners = new Set<AiSessionProviderTimelineItemListener>();
  private readonly providerTimelineSubscriptions = new Map<string, () => void>();

  constructor(private readonly registry: AiSessionRegistry) {}

  register(provider: AiSessionControlProvider) {
    this.providerTimelineSubscriptions.get(provider.agent)?.();
    this.providers.set(provider.agent, provider);
    if (provider.subscribeTimelineItems) {
      this.providerTimelineSubscriptions.set(
        provider.agent,
        provider.subscribeTimelineItems((event) => {
          for (const listener of this.timelineItemListeners) listener(event);
        }),
      );
    } else {
      this.providerTimelineSubscriptions.delete(provider.agent);
    }
  }

  subscribeTimelineItems(listener: AiSessionProviderTimelineItemListener) {
    this.timelineItemListeners.add(listener);
    return () => this.timelineItemListeners.delete(listener);
  }

  provider(agent: string) {
    const provider = this.providers.get(agent);
    if (!provider) {
      throw aiSessionControlError("AI_SESSION_CONTROL_UNSUPPORTED", `${agent} sessions do not support direct control yet.`, 400);
    }
    return provider;
  }

  timelineCapabilities(): AiSessionTimelineCapabilities {
    const providers = [...this.providers.values()];
    const supports = (provider: AiSessionControlProvider, capability: keyof AiSessionProviderTimelineCapabilities) => {
      const reported = provider.timelineCapabilities?.();
      if (reported) return reported[capability];
      if (capability === "sessionRead") return Boolean(provider.timeline);
      if (capability === "turnRead") return Boolean(provider.turnTimeline);
      return Boolean(provider.subscribeTimelineItems);
    };
    return {
      sessionReadAgents: providers.filter((provider) => supports(provider, "sessionRead")).map((provider) => provider.agent),
      turnReadAgents: providers.filter((provider) => supports(provider, "turnRead")).map((provider) => provider.agent),
      liveItemAgents: providers.filter((provider) => supports(provider, "liveItems")).map((provider) => provider.agent),
    };
  }

  async createSession(agent: string, input: AiSessionProviderCreateInput) {
    const provider = this.provider(agent);
    if (!provider.createSession) {
      throw aiSessionControlError("AI_SESSION_CREATE_UNSUPPORTED", `${agent} does not support direct AI session creation.`, 400);
    }
    return provider.createSession(input);
  }

  async forkSession(sessionId: string, input: { throughTurnId?: string; cwd?: string } = {}) {
    const source = this.requireSession(sessionId);
    if (!source.providerSessionId || source.actions?.fork !== true) {
      throw aiSessionControlError("AI_SESSION_FORK_UNSUPPORTED", "AI session does not support Fork.", 409);
    }
    const provider = this.requireProvider(source);
    if (!provider.forkSession) {
      throw aiSessionControlError("AI_SESSION_FORK_UNSUPPORTED", `${source.agent} does not support Fork.`, 409);
    }
    let providerThroughTurnId: string | undefined;
    if (input.throughTurnId) {
      const turn = source.turns?.find((candidate) => candidate.id === input.throughTurnId);
      if (!turn && source.activeTurnId === input.throughTurnId && isSessionBusy(source)) {
        throw aiSessionControlError("AI_SESSION_FORK_INVALID_TURN_STATE", "An in-progress turn cannot be used as the Fork boundary.", 409);
      }
      if (!turn) throw aiSessionControlError("AI_SESSION_FORK_TURN_NOT_FOUND", "Fork turn was not found.", 404);
      if (turn.status === "running" || turn.status === "waiting") {
        throw aiSessionControlError("AI_SESSION_FORK_INVALID_TURN_STATE", "An in-progress turn cannot be used as the Fork boundary.", 409);
      }
      providerThroughTurnId = turn.providerTurnId;
      if (!providerThroughTurnId) {
        throw aiSessionControlError("AI_SESSION_FORK_TURN_NOT_FOUND", "Fork turn has no provider identity.", 409);
      }
    }
    return provider.forkSession({ source, throughTurnId: input.throughTurnId, providerThroughTurnId, cwd: input.cwd });
  }

  async sendMessage(sessionId: string, input: AiSessionSendInput) {
    const session = this.requireSession(sessionId);
    const message = input.message.trim();
    if (!message) {
      throw aiSessionControlError("AI_SESSION_MESSAGE_EMPTY", "Message is required.");
    }
    if (input.references?.length && session.agent !== "codex") {
      throw aiSessionControlError("AI_SESSION_REFERENCES_UNSUPPORTED", `${session.agent} sessions do not support Codex references.`, 400);
    }
    if (input.permissionMode && session.agent !== "codex") {
      throw aiSessionControlError("AI_SESSION_PERMISSION_MODE_UNSUPPORTED", `${session.agent} sessions do not support Codex permission modes.`, 400);
    }
    const mode = input.mode || "auto";
    const prepared = this.prepareMessage(session, { ...input, message });
    if (mode === "queue" || (mode === "auto" && isSessionBusy(session))) {
      const queued = this.registry.enqueueMessage(session.id, message, prepared.attachments || [], input.references || [], input.permissionMode, prepared.messageId);
      if (!queued) {
        throw aiSessionControlError("AI_SESSION_NOT_FOUND", "AI session not found.", 404);
      }
      return { session: queued.session, provider: session.agent, action: "queue" as const, queueId: queued.item.id };
    }
    if (mode === "steer") {
      return this.steerPreparedMessage(session, prepared);
    }
    if (isSessionBusy(session)) {
      throw aiSessionControlError("AI_SESSION_BUSY", "AI session is busy. Queue the message or steer it into the running turn.", 409);
    }
    return this.startPreparedMessage(session, prepared);
  }

  async startMessage(sessionId: string, input: AiSessionSendInput) {
    const session = this.requireSession(sessionId);
    if (isSessionBusy(session)) {
      throw aiSessionControlError("AI_SESSION_BUSY", "AI session is busy. Queue the message or steer it into the running turn.", 409);
    }
    return this.startPreparedMessage(session, this.prepareMessage(session, input));
  }

  private async startPreparedMessage(session: AiSessionStatus, input: AiSessionSendInput) {
    const provider = this.requireProvider(session);
    const start = provider.startMessage || provider.sendMessage;
    if (!start) {
      throw aiSessionControlError("AI_SESSION_SEND_UNSUPPORTED", `${session.agent} sessions do not support starting turns.`, 400);
    }
    try {
      const result = await start.call(provider, session, input);
      if (input.messageId) this.registry.commitMessageAttachments(session.id, input.messageId, result?.turnId);
      return result;
    } catch (error) {
      if (input.messageId) this.registry.rollbackMessageAttachments(session.id, input.messageId);
      throw error;
    }
  }

  async steerMessage(sessionId: string, input: string | AiSessionSendInput) {
    const session = this.requireSession(sessionId);
    if (!isSessionBusy(session)) {
      throw aiSessionControlError("AI_SESSION_NOT_ACTIVE", "AI session is not active.", 409);
    }
    return this.steerPreparedMessage(session, this.prepareMessage(session, typeof input === "string" ? { message: input } : input));
  }

  private async steerPreparedMessage(session: AiSessionStatus, input: AiSessionSendInput) {
    const provider = this.requireProvider(session);
    const steer = provider.steerMessage || provider.sendMessage;
    if (!steer) {
      throw aiSessionControlError("AI_SESSION_STEER_UNSUPPORTED", `${session.agent} sessions do not support turn steering.`, 400);
    }
    try {
      const result = await steer.call(provider, session, input);
      if (input.messageId) this.registry.commitMessageAttachments(session.id, input.messageId, result?.turnId || session.activeTurnId);
      return result;
    } catch (error) {
      if (input.messageId) this.registry.rollbackMessageAttachments(session.id, input.messageId);
      throw error;
    }
  }

  private prepareMessage(session: AiSessionStatus, input: AiSessionSendInput): AiSessionSendInput {
    if (input.messageId && input.userMessageAttachments) return input;
    const messageId = input.messageId || `msg_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
    const staged = this.registry.stageMessageAttachments({
      sessionId: session.id,
      messageId,
      attachments: input.attachments,
      runtimePathRoot: session.cwd,
      draftAttachmentIds: input.draftAttachmentIds,
      draftScopeType: input.draftScopeType,
      draftScopeId: input.draftScopeId,
    });
    return {
      ...input,
      messageId,
      attachments: staged.providerAttachments,
      userMessageAttachments: staged.attachments,
    };
  }

  async sendNextQueuedMessage(sessionId: string) {
    const session = this.requireSession(sessionId);
    if (isSessionBusy(session)) {
      return undefined;
    }
    const item = this.registry.nextQueuedMessage(session.id);
    if (!item) {
      return undefined;
    }
    this.registry.markQueuedMessageSending(session.id, item.id);
    try {
      const result = await this.startMessage(session.id, { message: item.message, messageId: item.messageId, attachments: this.registry.queuedMessageAttachments(item.id), userMessageAttachments: item.attachments.map((attachment) => ({ ...attachment, contentState: "available" as const })), references: item.references, permissionMode: item.permissionMode });
      const updated = this.registry.removeQueuedMessage(session.id, item.id);
      return { ...result, session: updated || result.session, queueId: item.id };
    } catch (error) {
      this.registry.markQueuedMessageFailed(session.id, item.id, error);
      throw error;
    }
  }

  async steerQueuedMessage(sessionId: string, queueId: string) {
    const session = this.requireSession(sessionId);
    const item = session.queue.items.find((entry) => entry.id === queueId);
    if (!item) {
      throw aiSessionControlError("AI_SESSION_QUEUE_ITEM_NOT_FOUND", "Queued message not found.", 404);
    }
    const result = await this.steerMessage(session.id, { message: item.message, messageId: item.messageId, attachments: this.registry.queuedMessageAttachments(item.id), userMessageAttachments: item.attachments.map((attachment) => ({ ...attachment, contentState: "available" as const })), references: item.references });
    const updated = this.registry.removeQueuedMessage(session.id, item.id);
    return { ...result, session: updated || result.session, action: "steer" as const, queueId: item.id };
  }

  retryQueuedMessage(sessionId: string, queueId: string) {
    const session = this.registry.retryQueuedMessage(sessionId, queueId);
    if (!session) {
      throw aiSessionControlError("AI_SESSION_QUEUE_ITEM_NOT_FOUND", "Queued message not found.", 404);
    }
    return session;
  }

  removeQueuedMessage(sessionId: string, queueId: string) {
    this.requireSession(sessionId);
    const session = this.registry.removeQueuedMessage(sessionId, queueId);
    if (!session) {
      throw aiSessionControlError("AI_SESSION_QUEUE_ITEM_NOT_FOUND", "Queued message not found.", 404);
    }
    return session;
  }

  editQueuedMessage(sessionId: string, queueId: string, expectedRevision: number, message: string) {
    const result = this.registry.editQueuedMessage(sessionId, queueId, expectedRevision, message);
    if (!result) throw aiSessionControlError("AI_SESSION_NOT_FOUND", "AI session not found.", 404);
    if (result.kind === "revision-conflict") {
      throw aiSessionControlError("AI_SESSION_QUEUE_REVISION_CONFLICT", `AI session queue changed at revision ${result.currentRevision}.`, 409);
    }
    if (result.kind === "not-found") {
      throw aiSessionControlError("AI_SESSION_QUEUE_ITEM_NOT_FOUND", "Queued message not found.", 404);
    }
    if (result.kind === "not-editable") {
      throw aiSessionControlError("AI_SESSION_QUEUE_ITEM_NOT_EDITABLE", "Only queued messages can be edited.", 409);
    }
    return result.session;
  }

  reorderQueuedMessages(sessionId: string, expectedRevision: number, queueIds: string[]) {
    const result = this.registry.reorderQueuedMessages(sessionId, expectedRevision, queueIds);
    if (!result) {
      throw aiSessionControlError("AI_SESSION_NOT_FOUND", "AI session not found.", 404);
    }
    if (result.kind === "revision-conflict") {
      throw aiSessionControlError("AI_SESSION_QUEUE_REVISION_CONFLICT", `AI session queue changed at revision ${result.currentRevision}.`, 409);
    }
    if (result.kind === "order-invalid") {
      throw aiSessionControlError("AI_SESSION_QUEUE_ORDER_INVALID", "Queue order must contain every currently queued message exactly once.", 409);
    }
    return result.session;
  }

  async interrupt(sessionId: string) {
    const session = this.requireSession(sessionId);
    if (session.status !== "running" && session.status !== "waiting") {
      throw aiSessionControlError("AI_SESSION_NOT_ACTIVE", "AI session is not active.", 400);
    }
    return this.requireProvider(session).interrupt(session);
  }

  async timeline(sessionId: string) {
    const session = this.requireSession(sessionId);
    const provider = this.requireProvider(session);
    if (!provider.timeline) {
      throw aiSessionControlError("AI_SESSION_TIMELINE_UNSUPPORTED", `${session.agent} sessions do not expose Timeline reads.`, 409);
    }
    return provider.timeline(session);
  }

  async turnTimeline(sessionId: string, turnId: string) {
    const session = this.requireSession(sessionId);
    const provider = this.requireProvider(session);
    if (!provider.turnTimeline) {
      throw aiSessionControlError("AI_SESSION_TURN_TIMELINE_UNSUPPORTED", `${session.agent} sessions do not expose per-turn Timeline reads.`, 409);
    }
    return provider.turnTimeline(session, turnId);
  }

  async resolveApproval(sessionId: string, decision: AiSessionApprovalDecision) {
    const session = this.requireSession(sessionId);
    const provider = this.requireProvider(session);
    if (provider.resolveApproval) {
      return provider.resolveApproval(session, decision);
    }
    throw aiSessionControlError("AI_SESSION_APPROVAL_UNSUPPORTED", `${session.agent} sessions do not expose structured approval control.`, 400);
  }

  private requireSession(sessionId: string) {
    const session = this.registry.get(sessionId);
    if (!session) {
      throw aiSessionControlError("AI_SESSION_NOT_FOUND", "AI session not found.", 404);
    }
    return session;
  }

  private requireProvider(session: AiSessionStatus) {
    return this.provider(session.agent);
  }
}

function isSessionBusy(session: AiSessionStatus) {
  return session.status === "running" || session.status === "waiting";
}

export function aiSessionControlError(code: string, message: string, statusCode = 400) {
  const error = new Error(message) as Error & { code: string; statusCode: number };
  error.code = code;
  error.statusCode = statusCode;
  return error;
}
