import { AiSessionCloseResultSchema, type AiSessionCloseResult, type AiSessionStatus } from "@task-handoff/protocol/ai-sessions";
import { aiSessionHistoryItem, aiSessionHistoryTurns } from "./ai-session-history-lifecycle";
import type { AiSessionHistoryStore } from "./ai-session-history-store";
import { aiSessionControlError, type AiSessionController } from "./ai-session-control";
import type { AiSessionRegistry } from "./ai-session-registry";

export type AiSessionCloseCoordinatorOptions = {
  registry: AiSessionRegistry;
  controller: AiSessionController;
  history: AiSessionHistoryStore;
  stopApp: (appSessionId: string) => void | Promise<void>;
  onDiagnostic?: (diagnostic: Record<string, unknown>) => void;
};

export class AiSessionCloseCoordinator {
  private readonly pending = new Map<string, Promise<AiSessionCloseResult>>();

  constructor(private readonly options: AiSessionCloseCoordinatorOptions) {}

  close(aiSessionId: string): Promise<AiSessionCloseResult> {
    const current = this.options.registry.get(aiSessionId);
    if (!current) {
      const archived = this.options.history.get(aiSessionId);
      if (!archived) throw aiSessionControlError("AI_SESSION_NOT_FOUND", "AI session not found.", 404);
      return Promise.resolve(AiSessionCloseResultSchema.parse({
        disposition: "already-closed",
        aiSessionId: archived.id,
        providerSessionId: archived.providerSessionId,
        creationSource: archived.creationSource,
      }));
    }
    const keys = this.keys(current);
    const active = keys.map((key) => this.pending.get(key)).find(Boolean);
    if (active) return active;
    const promise = this.perform(current).finally(() => {
      for (const key of keys) if (this.pending.get(key) === promise) this.pending.delete(key);
    });
    for (const key of keys) this.pending.set(key, promise);
    return promise;
  }

  closeForAppSession(appSessionId: string) {
    const session = this.options.registry.all().find((candidate) =>
      candidate.appSessionId === appSessionId && candidate.creationSource === "app-session"
    );
    return session ? this.close(session.id) : undefined;
  }

  private async perform(session: AiSessionStatus): Promise<AiSessionCloseResult> {
    if (!session.providerSessionId) {
      throw aiSessionControlError("AI_SESSION_CLOSE_UNAVAILABLE", "AI session has no provider identity.", 409);
    }
    const provider = this.options.controller.provider(session.agent);
    if (!provider.archiveSession) {
      throw aiSessionControlError("AI_SESSION_CLOSE_UNSUPPORTED", `${session.agent} does not support provider archive.`, 400);
    }
    const frozen: AiSessionStatus = {
      ...session,
      actions: { ...session.actions, send: false, interrupt: false, approval: false, openApp: false, close: false },
      queue: { revision: 0, pendingCount: 0, items: [] },
    };
    this.options.registry.put(frozen);
    try {
      if ((session.status === "running" || session.status === "waiting") && session.activeTurnId) {
        await this.options.controller.interrupt(session.id);
      }
      await provider.archiveSession(session.providerSessionId);
      if (session.appSessionId) await this.options.stopApp(session.appSessionId);
      await provider.unsubscribeSession?.(session.providerSessionId);
      const item = aiSessionHistoryItem(session);
      if (!item) throw new Error("AI session could not be converted to resumable history.");
      this.options.history.upsert(item, aiSessionHistoryTurns(session));
      this.options.registry.discard(session.id);
      return AiSessionCloseResultSchema.parse({
        disposition: "closed",
        aiSessionId: session.id,
        providerSessionId: session.providerSessionId,
        creationSource: session.creationSource,
      });
    } catch (error: unknown) {
      try { await provider.resumeSession?.(session.providerSessionId); } catch (resumeError: unknown) {
        this.options.onDiagnostic?.({
          code: "AI_SESSION_CLOSE_ROLLBACK_FAILED",
          aiSessionId: session.id,
          providerSessionId: session.providerSessionId,
          error: resumeError instanceof Error ? resumeError.message : String(resumeError),
        });
      }
      this.options.registry.put(session);
      throw aiSessionControlError(
        "AI_SESSION_CLOSE_FAILED",
        error instanceof Error ? error.message : "AI session could not be closed.",
        409,
      );
    }
  }

  private keys(session: AiSessionStatus) {
    return [`ai:${session.id}`, `provider:${session.agent}:${session.providerSessionId || "missing"}`];
  }
}
