import type { AiSessionStatus } from "@task-handoff/protocol/ai-sessions";
import type { AiSessionActionResult, AiSessionApprovalDecision } from "../../ai-session-control";
import { aiSessionControlError, PendingAiSessionApprovalStore } from "../../ai-session-control";
import type { AiSessionRegistry } from "../../ai-session-registry";
import { waitFor } from "../protocol/async";
import type { CodexAppServerClientLike } from "../client/contract";
import { lifecycleForStatus } from "../protocol/status";
import type { CodexApprovalRequest, CodexThread } from "../protocol/types";

type ApprovalCoordinatorOptions = {
  registry: AiSessionRegistry;
  currentClient: () => CodexAppServerClientLike | undefined;
  readyClient: () => Promise<CodexAppServerClientLike>;
  readyThreadClient?: (threadId: string) => Promise<CodexAppServerClientLike>;
  findSession: (threadId: string) => AiSessionStatus | undefined;
  applyThreadSnapshot: (thread: CodexThread) => void;
};

export class CodexAppServerApprovalCoordinator {
  private readonly pending = new PendingAiSessionApprovalStore();
  private connectionEpoch = 0;

  constructor(private readonly options: ApprovalCoordinatorOptions) {}

  latestForSession(sessionId: string) {
    return this.pending.latestForSession(sessionId);
  }

  clearSession(sessionId: string) {
    this.pending.clearSession(sessionId);
  }

  resetConnection() {
    this.connectionEpoch += 1;
    this.pending.clear();
  }

  attachLifecycle(sessionId: string | undefined, lifecycle: ReturnType<typeof lifecycleForStatus>): ReturnType<typeof lifecycleForStatus> {
    if (lifecycle.phase !== "approval" || sessionId && this.pending.latestForSession(sessionId)) {
      return lifecycle;
    }
    return { status: "waiting", phase: "thinking" };
  }

  register(request: CodexApprovalRequest) {
    const session = this.options.findSession(request.threadId);
    const client = this.options.currentClient();
    if (!session || !client?.respondToApproval) {
      return;
    }
    const connectionEpoch = this.connectionEpoch;
    this.pending.register({
      id: `${request.threadId}:${request.id}`,
      sessionId: session.id,
      provider: "codex",
      summary: request.summary,
      metadata: { kind: request.kind, requestId: request.id, itemId: request.itemId },
      resolve: async (decision) => {
        const currentClient = this.options.currentClient();
        if (connectionEpoch !== this.connectionEpoch || currentClient !== client || !currentClient.respondToApproval) {
          throw aiSessionControlError(
            "AI_SESSION_APPROVAL_CONNECTION_CHANGED",
            "The Codex connection changed before the approval could be resolved. Wait for the app-server to replay the pending request.",
            409,
          );
        }
        await currentClient.respondToApproval(request, decision);
      },
    });
    this.options.registry.applyRealtimeEvent(session.id, {
      kind: "approval-requested",
      activeTurnId: request.turnId || session.activeTurnId,
      providerTurnId: request.turnId || session.activeTurnId,
      status: "waiting",
      phase: "approval",
      summary: request.summary,
      counters: { approvals: 1 },
      source: "realtime",
    });
  }

  async resolve(session: AiSessionStatus, decision: AiSessionApprovalDecision): Promise<AiSessionActionResult> {
    let attached = await this.pending.resolveForSession(session.id, decision);
    if (!attached) {
      await this.attachPendingRequest(session);
      attached = await this.pending.resolveForSession(session.id, decision);
    }
    if (!attached) {
      throw aiSessionControlError(
        "AI_SESSION_APPROVAL_NOT_ATTACHED",
        "Codex approval request is not attached to this control connection. The app-server did not replay a pending approval request for this session.",
        409,
      );
    }
    const updated = this.options.registry.applyRealtimeEvent(session.id, {
      kind: "lifecycle",
      status: decision === "skip" ? "idle" : "running",
      phase: decision === "skip" ? "unknown" : "thinking",
      source: "control",
    }) || session;
    return { session: updated, provider: "codex", action: "approval", decision };
  }

  private async attachPendingRequest(session: AiSessionStatus) {
    if (this.pending.latestForSession(session.id)) {
      return;
    }
    if (!session.providerSessionId) {
      throw aiSessionControlError("AI_SESSION_THREAD_NOT_FOUND", "AI session is not bound to a Codex thread.");
    }
    const client = this.options.readyThreadClient
      ? await this.options.readyThreadClient(session.providerSessionId)
      : await this.options.readyClient();
    if (!this.options.readyThreadClient && client.resumeThread) {
      const resumed = await client.resumeThread(session.providerSessionId);
      if (resumed) this.options.applyThreadSnapshot(resumed);
    }
    await waitFor(() => Boolean(this.pending.latestForSession(session.id)), 1_000);
  }
}
