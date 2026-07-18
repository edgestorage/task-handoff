import type { AiSessionStatus } from "@task-handoff/protocol/ai-sessions";
import type { AiSessionActionResult, AiSessionSendInput } from "../../ai-session-control";
import { aiSessionControlError } from "../../ai-session-control";
import { withAttachmentPathFallback } from "../../ai-session-attachments";
import type { AiSessionRegistry } from "../../ai-session-registry";
import type { CodexAppServerClientLike } from "../client/contract";
import { activeTurnMismatchFoundId, isNoActiveTurnError } from "../protocol/turn-control";

type SessionControlOptions = {
  registry: AiSessionRegistry;
  readyClient: () => Promise<CodexAppServerClientLike>;
};

export class CodexAppServerSessionControl {
  constructor(private readonly options: SessionControlOptions) {}

  async sendMessage(session: AiSessionStatus, input: AiSessionSendInput): Promise<AiSessionActionResult> {
    const client = await this.options.readyClient();
    const threadId = this.requireThreadId(session);
    const result = await withAttachmentPathFallback(input.message, input.attachments, (providerMessage) => (
      this.steerOrStartTurnForCompatibility(client, threadId, session, providerMessage)
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
    const threadId = this.requireThreadId(session);
    const result = await withAttachmentPathFallback(input.message, input.attachments, (providerMessage) => (
      this.startTurn(client, threadId, providerMessage)
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
    const threadId = this.requireThreadId(session);
    const result = await withAttachmentPathFallback(input.message, input.attachments, (providerMessage) => (
      this.steerTurn(client, threadId, session, providerMessage)
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

  private async steerTurn(client: CodexAppServerClientLike, threadId: string, session: AiSessionStatus, message: string) {
    if (!session.activeTurnId) {
      throw aiSessionControlError("AI_SESSION_NO_ACTIVE_TURN", "AI session has no active turn to steer.", 409);
    }
    if (!client.steerTurn) {
      throw aiSessionControlError("AI_SESSION_STEER_UNSUPPORTED", "Codex app-server client does not support turn steering.");
    }
    try {
      return { turnId: (await client.steerTurn(threadId, session.activeTurnId, message)).turnId || session.activeTurnId };
    } catch (error) {
      const currentTurnId = activeTurnMismatchFoundId(error);
      if (currentTurnId) {
        return { turnId: (await client.steerTurn(threadId, currentTurnId, message)).turnId || currentTurnId };
      }
      throw error;
    }
  }

  private async steerOrStartTurnForCompatibility(client: CodexAppServerClientLike, threadId: string, session: AiSessionStatus, message: string) {
    const shouldSteer = Boolean(session.activeTurnId && (session.status === "running" || session.status === "waiting"));
    if (!shouldSteer) {
      return this.startTurn(client, threadId, message);
    }
    try {
      return { ...(await this.steerTurn(client, threadId, session, message)), started: false };
    } catch (error) {
      if (!isNoActiveTurnError(error)) {
        throw error;
      }
      return this.startTurn(client, threadId, message);
    }
  }

  private async startTurn(client: CodexAppServerClientLike, threadId: string, message: string) {
    if (!client.startTurn) {
      throw aiSessionControlError("AI_SESSION_SEND_UNSUPPORTED", "Codex app-server client does not support starting turns.");
    }
    return { turnId: (await client.startTurn(threadId, message)).turnId, started: true };
  }

  private requireThreadId(session: AiSessionStatus) {
    if (!session.providerSessionId) {
      throw aiSessionControlError("AI_SESSION_THREAD_NOT_FOUND", "AI session is not bound to a Codex thread.");
    }
    return session.providerSessionId;
  }
}
