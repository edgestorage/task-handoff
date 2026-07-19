import type {
  AiSessionActionResult,
  AiSessionApprovalInput,
  AiSessionMessageAttachment,
  AiSessionReference,
  AiSessionSendMode,
  AiSessionStatus,
} from "@task-handoff/protocol/ai-sessions";
import type { AiSessionRegistry } from "./ai-session-registry";

export type AiSessionSendInput = {
  message: string;
  mode?: AiSessionSendMode;
  attachments?: AiSessionMessageAttachment[];
  references?: AiSessionReference[];
};

export type AiSessionApprovalDecision = AiSessionApprovalInput["decision"];
export type { AiSessionActionResult } from "@task-handoff/protocol/ai-sessions";

export type PendingAiSessionApproval = {
  id: string;
  sessionId: string;
  provider: string;
  summary: string;
  metadata?: Record<string, unknown>;
  resolve: (decision: AiSessionApprovalDecision) => Promise<void> | void;
};

export interface AiSessionControlProvider {
  readonly agent: string;
  startMessage?(session: AiSessionStatus, input: AiSessionSendInput): Promise<AiSessionActionResult>;
  steerMessage?(session: AiSessionStatus, input: AiSessionSendInput): Promise<AiSessionActionResult>;
  sendMessage?(session: AiSessionStatus, input: AiSessionSendInput): Promise<AiSessionActionResult>;
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

  constructor(private readonly registry: AiSessionRegistry) {}

  register(provider: AiSessionControlProvider) {
    this.providers.set(provider.agent, provider);
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
    const mode = input.mode || "auto";
    if (mode === "queue" || (mode === "auto" && isSessionBusy(session))) {
      const queued = this.registry.enqueueMessage(session.id, message, input.attachments || [], input.references || []);
      if (!queued) {
        throw aiSessionControlError("AI_SESSION_NOT_FOUND", "AI session not found.", 404);
      }
      return { session: queued.session, provider: session.agent, action: "queue" as const, queueId: queued.item.id };
    }
    if (mode === "steer") {
      return this.steerMessage(session.id, { message, attachments: input.attachments || [], references: input.references || [] });
    }
    if (isSessionBusy(session)) {
      throw aiSessionControlError("AI_SESSION_BUSY", "AI session is busy. Queue the message or steer it into the running turn.", 409);
    }
    return this.startMessage(session.id, { message, attachments: input.attachments || [], references: input.references || [] });
  }

  async startMessage(sessionId: string, input: { message: string; attachments?: AiSessionMessageAttachment[]; references?: AiSessionReference[] }) {
    const session = this.requireSession(sessionId);
    if (isSessionBusy(session)) {
      throw aiSessionControlError("AI_SESSION_BUSY", "AI session is busy. Queue the message or steer it into the running turn.", 409);
    }
    const provider = this.requireProvider(session);
    const start = provider.startMessage || provider.sendMessage;
    if (!start) {
      throw aiSessionControlError("AI_SESSION_SEND_UNSUPPORTED", `${session.agent} sessions do not support starting turns.`, 400);
    }
    return start.call(provider, session, input);
  }

  async steerMessage(sessionId: string, input: string | { message: string; attachments?: AiSessionMessageAttachment[]; references?: AiSessionReference[] }) {
    const session = this.requireSession(sessionId);
    if (!isSessionBusy(session)) {
      throw aiSessionControlError("AI_SESSION_NOT_ACTIVE", "AI session is not active.", 409);
    }
    const provider = this.requireProvider(session);
    const steer = provider.steerMessage || provider.sendMessage;
    if (!steer) {
      throw aiSessionControlError("AI_SESSION_STEER_UNSUPPORTED", `${session.agent} sessions do not support turn steering.`, 400);
    }
    const normalized = typeof input === "string" ? { message: input } : input;
    return steer.call(provider, session, normalized);
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
      const result = await this.startMessage(session.id, { message: item.message, attachments: this.registry.queuedMessageAttachments(item.id), references: item.references });
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
    const result = await this.steerMessage(session.id, { message: item.message, attachments: this.registry.queuedMessageAttachments(item.id), references: item.references });
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
    const session = this.registry.removeQueuedMessage(sessionId, queueId);
    if (!session) {
      throw aiSessionControlError("AI_SESSION_NOT_FOUND", "AI session not found.", 404);
    }
    return session;
  }

  reorderQueuedMessages(sessionId: string, queueIds: string[]) {
    const session = this.registry.reorderQueuedMessages(sessionId, queueIds);
    if (!session) {
      throw aiSessionControlError("AI_SESSION_NOT_FOUND", "AI session not found.", 404);
    }
    return session;
  }

  async interrupt(sessionId: string) {
    const session = this.requireSession(sessionId);
    if (session.status !== "running" && session.status !== "waiting") {
      throw aiSessionControlError("AI_SESSION_NOT_ACTIVE", "AI session is not active.", 400);
    }
    return this.requireProvider(session).interrupt(session);
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
    const provider = this.providers.get(session.agent);
    if (!provider) {
      throw aiSessionControlError("AI_SESSION_CONTROL_UNSUPPORTED", `${session.agent} sessions do not support direct control yet.`, 400);
    }
    return provider;
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
