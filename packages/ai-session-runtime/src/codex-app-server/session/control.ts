import type { AiSessionPermissionMode, AiSessionReference, AiSessionStatus } from "@task-handoff/protocol/ai-sessions";
import type { AiSessionActionResult, AiSessionSendInput } from "../../ai-session-control";
import { aiSessionControlError } from "../../ai-session-control";
import { withAttachmentPathFallback } from "../../ai-session-attachments";
import type { AiSessionRegistry } from "../../ai-session-registry";
import type { CodexAppServerClientLike, CodexTurnPermissionOverrides } from "../client/contract";
import type { CodexUserInput } from "../protocol/types";
import { activeTurnMismatchFoundId, isNoActiveTurnError } from "../protocol/turn-control";

type SessionControlOptions = {
  registry: AiSessionRegistry;
  readyClient: () => Promise<CodexAppServerClientLike>;
  validateReferences?: (session: AiSessionStatus, references: AiSessionReference[]) => Promise<AiSessionReference[]>;
};

export class CodexAppServerSessionControl {
  constructor(private readonly options: SessionControlOptions) {}

  async sendMessage(session: AiSessionStatus, input: AiSessionSendInput): Promise<AiSessionActionResult> {
    const client = await this.options.readyClient();
    const references = await this.validateReferences(session, input.references || []);
    const threadId = this.requireThreadId(session);
    const result = await withAttachmentPathFallback(input.message, input.attachments, session.cwd, (providerMessage) => (
      this.steerOrStartTurnForCompatibility(client, threadId, session, providerMessage, references, input.permissionMode)
    ));
    const updated = this.options.registry.applyRealtimeEvent(session.id, {
      kind: result.started ? "send-ack" : "user-message",
      activeTurnId: result.turnId,
      providerTurnId: result.turnId,
      userPrompt: input.message,
      source: "control",
    }) || session;
    return { session: updated, provider: "codex", action: result.started ? "send" : "steer", turnId: updated.activeTurnId, providerTurnId: result.turnId };
  }

  async startMessage(session: AiSessionStatus, input: AiSessionSendInput): Promise<AiSessionActionResult> {
    const client = await this.options.readyClient();
    const references = await this.validateReferences(session, input.references || []);
    const threadId = this.requireThreadId(session);
    const result = await withAttachmentPathFallback(input.message, input.attachments, session.cwd, (providerMessage) => (
      this.startTurn(client, threadId, providerMessage, references, input.permissionMode)
    ));
    const updated = this.options.registry.applyRealtimeEvent(session.id, {
      kind: "send-ack",
      activeTurnId: result.turnId,
      providerTurnId: result.turnId,
      userPrompt: input.message,
      source: "control",
    }) || session;
    return { session: updated, provider: "codex", action: "send", turnId: updated.activeTurnId, providerTurnId: result.turnId };
  }

  async steerMessage(session: AiSessionStatus, input: AiSessionSendInput): Promise<AiSessionActionResult> {
    const client = await this.options.readyClient();
    const references = await this.validateReferences(session, input.references || []);
    const threadId = this.requireThreadId(session);
    const result = await withAttachmentPathFallback(input.message, input.attachments, session.cwd, (providerMessage) => (
      this.steerTurn(client, threadId, session, providerMessage, references)
    ));
    const updated = this.options.registry.applyRealtimeEvent(session.id, {
      kind: "user-message",
      activeTurnId: result.turnId,
      providerTurnId: result.turnId,
      userPrompt: input.message,
      source: "control",
    }) || session;
    return { session: updated, provider: "codex", action: "steer", turnId: updated.activeTurnId, providerTurnId: result.turnId };
  }

  async interrupt(session: AiSessionStatus): Promise<AiSessionActionResult> {
    const client = await this.options.readyClient();
    const threadId = this.requireThreadId(session);
    const turnId = session.activeTurnId;
    if (!turnId) {
      throw aiSessionControlError("AI_SESSION_NO_ACTIVE_TURN", "AI session has no active turn to interrupt.");
    }
    if (!client.interruptTurn) {
      throw aiSessionControlError("AI_SESSION_INTERRUPT_UNSUPPORTED", "Codex app-server client does not support turn interruption.");
    }
    try {
      await client.interruptTurn(threadId, turnId);
    } catch (error) {
      const currentTurnId = activeTurnMismatchFoundId(error);
      if (currentTurnId) {
        await client.interruptTurn(threadId, currentTurnId);
        const updated = this.options.registry.applyRealtimeEvent(session.id, {
          kind: "lifecycle",
          activeTurnId: currentTurnId,
          status: "running",
          phase: "unknown",
          source: "control",
        }) || session;
        return { session: updated, provider: "codex", action: "interrupt", providerTurnId: currentTurnId };
      }
      if (!isNoActiveTurnError(error)) {
        throw error;
      }
      const updated = this.options.registry.applyRealtimeEvent(session.id, {
        kind: "turn-completed",
        activeTurnId: undefined,
        status: "idle",
        phase: "unknown",
        text: "Codex turn is no longer active.",
        source: "control",
      }) || session;
      return { session: updated, provider: "codex", action: "interrupt", providerTurnId: turnId };
    }
    const updated = this.options.registry.applyRealtimeEvent(session.id, {
      kind: "lifecycle",
      status: "running",
      phase: "unknown",
      source: "control",
    }) || session;
    return { session: updated, provider: "codex", action: "interrupt", providerTurnId: turnId };
  }

  private async steerTurn(client: CodexAppServerClientLike, threadId: string, session: AiSessionStatus, message: string, references: AiSessionReference[] = []) {
    if (!session.activeTurnId) {
      throw aiSessionControlError("AI_SESSION_NO_ACTIVE_TURN", "AI session has no active turn to steer.", 409);
    }
    if (!client.steerTurn) {
      throw aiSessionControlError("AI_SESSION_STEER_UNSUPPORTED", "Codex app-server client does not support turn steering.");
    }
    try {
      return { turnId: (await client.steerTurn(threadId, session.activeTurnId, message, codexInputs(message, references))).turnId || session.activeTurnId };
    } catch (error) {
      const currentTurnId = activeTurnMismatchFoundId(error);
      if (currentTurnId) {
        return { turnId: (await client.steerTurn(threadId, currentTurnId, message, codexInputs(message, references))).turnId || currentTurnId };
      }
      throw error;
    }
  }

  private async steerOrStartTurnForCompatibility(client: CodexAppServerClientLike, threadId: string, session: AiSessionStatus, message: string, references: AiSessionReference[], permissionMode?: AiSessionPermissionMode) {
    const shouldSteer = Boolean(session.activeTurnId && (session.status === "running" || session.status === "waiting"));
    if (!shouldSteer) {
      return this.startTurn(client, threadId, message, references, permissionMode);
    }
    try {
      return { ...(await this.steerTurn(client, threadId, session, message, references)), started: false };
    } catch (error) {
      if (!isNoActiveTurnError(error)) {
        throw error;
      }
      return this.startTurn(client, threadId, message, references, permissionMode);
    }
  }

  private async startTurn(client: CodexAppServerClientLike, threadId: string, message: string, references: AiSessionReference[] = [], permissionMode?: AiSessionPermissionMode) {
    if (!client.startTurn) {
      throw aiSessionControlError("AI_SESSION_SEND_UNSUPPORTED", "Codex app-server client does not support starting turns.");
    }
    return { turnId: (await client.startTurn(threadId, message, codexInputs(message, references), codexPermissionOverrides(permissionMode))).turnId, started: true };
  }

  private validateReferences(session: AiSessionStatus, references: AiSessionReference[]) {
    return this.options.validateReferences ? this.options.validateReferences(session, references) : Promise.resolve(references);
  }

  private requireThreadId(session: AiSessionStatus) {
    if (!session.providerSessionId) {
      throw aiSessionControlError("AI_SESSION_THREAD_NOT_FOUND", "AI session is not bound to a Codex thread.");
    }
    return session.providerSessionId;
  }
}

export function codexPermissionOverrides(mode?: AiSessionPermissionMode): CodexTurnPermissionOverrides | undefined {
  if (mode === "ask") {
    return { approvalPolicy: "on-request", approvalsReviewer: "user", permissions: ":workspace" };
  }
  if (mode === "auto-review") {
    return { approvalPolicy: "on-request", approvalsReviewer: "auto_review", permissions: ":workspace" };
  }
  if (mode === "full-access") {
    return { approvalPolicy: "never", approvalsReviewer: "user", permissions: ":danger-full-access" };
  }
  return undefined;
}

function codexInputs(message: string, references: AiSessionReference[]): CodexUserInput[] {
  return [
    { type: "text", text: message, text_elements: [] },
    ...references.map((reference): CodexUserInput => reference.kind === "skill"
      ? { type: "skill", name: reference.name, path: reference.path }
      : { type: "mention", name: reference.name, path: reference.path }),
  ];
}
