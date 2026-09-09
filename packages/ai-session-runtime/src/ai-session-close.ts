import { AiSessionClearResultSchema, AiSessionCloseResultSchema, type AiSessionClearResult, type AiSessionCloseResult, type AiSessionHistoryItem, type AiSessionStatus } from "@task-handoff/protocol/ai-sessions";
import { aiSessionSubtreePostorder, deriveAiSessionForest, type AiSessionForest } from "@task-handoff/protocol/ai-session-hierarchy";
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
  releaseSessionResources?: (sessionId: string) => void;
};

export class AiSessionCloseCoordinator {
  private readonly pending = new Map<string, {
    targetId: string;
    sessionIds: Set<string>;
    promise: Promise<AiSessionCloseResult>;
  }>();
  private readonly pendingClears = new Map<string, Promise<AiSessionClearResult>>();

  constructor(private readonly options: AiSessionCloseCoordinatorOptions) {}

  close(aiSessionId: string): Promise<AiSessionCloseResult> {
    return this.closeSubtree(aiSessionId, new Set());
  }

  async convergeObservedProviderLifecycle(
    session: AiSessionStatus,
    disposition: "closed" | "cleared",
  ): Promise<AiSessionCloseResult | AiSessionClearResult> {
    const currentIdentity = session.providerSessionId
      ? this.options.registry.getByProviderSessionId(session.agent, session.providerSessionId)
      : undefined;
    if (currentIdentity && currentIdentity.id !== session.id) {
      throw aiSessionControlError("AI_SESSION_PROVIDER_IDENTITY_CONFLICT", "AI session provider identity was replaced before lifecycle convergence.", 409);
    }
    if (!this.options.registry.get(session.id)) this.options.registry.restoreAuthority(session);
    return disposition === "cleared"
      ? this.clearSubtree(session.id, new Set([session.id]))
      : this.closeSubtree(session.id, new Set([session.id]));
  }

  private closeSubtree(aiSessionId: string, providerAbsentIds: ReadonlySet<string>): Promise<AiSessionCloseResult> {
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
    const forest = deriveAiSessionForest(this.options.registry.all());
    const frozen = aiSessionSubtreePostorder(forest, current.id).map((node) => node.session);
    const keys = frozen.flatMap((session) => this.keys(session));
    const active = [...new Set(keys.flatMap((key) => {
      const operation = this.pending.get(key);
      return operation ? [operation] : [];
    }))];
    if (active.length) {
      if (active.length === 1 && active[0].targetId === aiSessionId) return active[0].promise;
      if (active.length === 1 && frozen.every((session) => active[0].sessionIds.has(session.id))) {
        return active[0].promise.then(() => this.alreadyClosed(aiSessionId));
      }
      return Promise.allSettled(active.map((operation) => operation.promise)).then(() => this.closeSubtree(aiSessionId, providerAbsentIds));
    }
    const operation = {
      targetId: aiSessionId,
      sessionIds: new Set(frozen.map((session) => session.id)),
      promise: undefined as unknown as Promise<AiSessionCloseResult>,
    };
    operation.promise = this.performSubtree(frozen, forest, providerAbsentIds).finally(() => {
      for (const key of keys) if (this.pending.get(key) === operation) this.pending.delete(key);
    });
    for (const key of keys) this.pending.set(key, operation);
    return operation.promise;
  }

  closeForAppSession(appSessionId: string) {
    const session = this.options.registry.all().find((candidate) =>
      candidate.appSessionId === appSessionId && candidate.creationSource === "app-session"
    );
    return session ? this.close(session.id) : undefined;
  }

  async clear(aiSessionId: string): Promise<AiSessionClearResult> {
    return this.clearSubtree(aiSessionId, new Set());
  }

  private async clearSubtree(aiSessionId: string, providerAbsentIds: ReadonlySet<string>): Promise<AiSessionClearResult> {
    const existing = this.pendingClears.get(aiSessionId);
    if (existing) return existing;
    const current = this.options.registry.all();
    const currentIds = new Set(current.map((session) => session.id));
    const history = this.options.history.list().filter((item) => !currentIds.has(item.id));
    const target = current.find((session) => session.id === aiSessionId) || history.find((item) => item.id === aiSessionId);
    if (!target) return AiSessionClearResultSchema.parse({ disposition: "already-cleared", aiSessionId, clearedSessionIds: [] });
    const records = [
      ...current,
      ...history.map((item) => ({ ...item, updatedAt: item.lastActiveAt })),
    ];
    const forest = deriveAiSessionForest(records);
    const frozen = aiSessionSubtreePostorder(forest, aiSessionId).map((node) => node.session);
    const operation = this.performClearSubtree(frozen, forest, providerAbsentIds).finally(() => {
      for (const session of frozen) if (this.pendingClears.get(session.id) === operation) this.pendingClears.delete(session.id);
    });
    for (const session of frozen) this.pendingClears.set(session.id, operation);
    return operation;
  }

  closeIfIdle(aiSessionId: string): Promise<AiSessionCloseResult | undefined> {
    const session = this.options.registry.get(aiSessionId);
    if (session) {
      const forest = deriveAiSessionForest(this.options.registry.all());
      if (aiSessionSubtreePostorder(forest, session.id).some((node) => node.session.status !== "idle")) {
        return Promise.resolve(undefined);
      }
    }
    return this.close(aiSessionId);
  }

  private alreadyClosed(aiSessionId: string) {
    const archived = this.options.history.get(aiSessionId);
    if (!archived) throw aiSessionControlError("AI_SESSION_NOT_FOUND", "AI session not found.", 404);
    return AiSessionCloseResultSchema.parse({
      disposition: "already-closed",
      aiSessionId: archived.id,
      providerSessionId: archived.providerSessionId,
      creationSource: archived.creationSource,
    });
  }

  private async performSubtree(
    frozen: AiSessionStatus[],
    forest: AiSessionForest<AiSessionStatus>,
    providerAbsentIds: ReadonlySet<string>,
  ): Promise<AiSessionCloseResult> {
    const target = frozen.at(-1)!;
    for (const session of frozen) {
      this.options.registry.patch(session.id, {
        actions: { ...session.actions, send: false, interrupt: false, approval: false, openApp: false, close: false },
        queue: { revision: 0, pendingCount: 0, items: [] },
      });
    }
    const blocked = new Set<string>();
    const failures: Array<{ session: AiSessionStatus; error: unknown }> = [];
    for (const session of frozen) {
      if (blocked.has(session.id)) {
        this.options.registry.restoreAuthority(session);
        continue;
      }
      try {
        await this.performOne(session, providerAbsentIds.has(session.id));
      } catch (error) {
        failures.push({ session, error });
        let node = forest.nodesById.get(session.id);
        while (node?.parentSessionId) {
          blocked.add(node.parentSessionId);
          node = forest.nodesById.get(node.parentSessionId);
        }
        this.options.onDiagnostic?.({
          code: "AI_SESSION_SUBTREE_CLOSE_FAILED",
          aiSessionId: session.id,
          providerSessionId: session.providerSessionId,
          blockedAncestorIds: [...blocked],
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (failures.length) {
      throw aiSessionControlError(
        "AI_SESSION_CLOSE_FAILED",
        failures[0].error instanceof Error ? failures[0].error.message : "AI session subtree could not be closed.",
        409,
      );
    }
    return AiSessionCloseResultSchema.parse({
      disposition: "closed",
      aiSessionId: target.id,
      providerSessionId: target.providerSessionId,
      creationSource: target.creationSource,
    });
  }

  private async performOne(session: AiSessionStatus, providerAlreadyAbsent = false): Promise<void> {
    if (!session.providerSessionId) {
      throw aiSessionControlError("AI_SESSION_CLOSE_UNAVAILABLE", "AI session has no provider identity.", 409);
    }
    const provider = this.options.controller.provider(session.agent);
    if (!provider.archiveSession) {
      throw aiSessionControlError("AI_SESSION_CLOSE_UNSUPPORTED", `${session.agent} does not support provider archive.`, 400);
    }
    try {
      if (!providerAlreadyAbsent && (session.status === "running" || session.status === "waiting") && session.activeTurnId) {
        await this.options.controller.interrupt(session.id);
      }
      if (!providerAlreadyAbsent) {
        try {
          await provider.archiveSession(session.providerSessionId);
        } catch (archiveError: unknown) {
          let stillActive = true;
          if (provider.activeSessionExists) {
            try {
              stillActive = await provider.activeSessionExists(session.providerSessionId);
            } catch {
              // The archive failure remains authoritative when provider state
              // cannot be verified independently.
            }
          }
          if (stillActive) throw archiveError;
          this.options.onDiagnostic?.({
            code: "AI_SESSION_CLOSE_PROVIDER_ALREADY_ABSENT",
            aiSessionId: session.id,
            providerSessionId: session.providerSessionId,
          });
        }
      }
      if (session.appSessionId) await this.options.stopApp(session.appSessionId);
      if (!providerAlreadyAbsent) await provider.unsubscribeSession?.(session.providerSessionId);
      const item = aiSessionHistoryItem(session);
      if (!item) throw new Error("AI session could not be converted to resumable history.");
      this.options.history.upsert(item, aiSessionHistoryTurns(session));
      this.options.registry.discard(session.id);
    } catch (error: unknown) {
      try { await provider.resumeSession?.(session.providerSessionId, session.modelSelection, session.reasoningEffort); } catch (resumeError: unknown) {
        this.options.onDiagnostic?.({
          code: "AI_SESSION_CLOSE_ROLLBACK_FAILED",
          aiSessionId: session.id,
          providerSessionId: session.providerSessionId,
          error: resumeError instanceof Error ? resumeError.message : String(resumeError),
        });
      }
      this.options.registry.restoreAuthority(session);
      throw error;
    }
  }

  private async performClearSubtree(
    frozen: Array<AiSessionStatus | (AiSessionHistoryItem & { updatedAt: string })>,
    forest: AiSessionForest<AiSessionStatus | (AiSessionHistoryItem & { updatedAt: string })>,
    providerAbsentIds: ReadonlySet<string>,
  ): Promise<AiSessionClearResult> {
    const target = frozen.at(-1)!;
    const blocked = new Set<string>();
    const clearedSessionIds: string[] = [];
    let firstError: unknown;
    for (const session of frozen) {
      if (blocked.has(session.id)) continue;
      const active = this.options.registry.get(session.id);
      try {
        if (!session.providerSessionId) throw aiSessionControlError("AI_SESSION_DELETE_UNAVAILABLE", "AI session has no provider identity.", 409);
        const provider = this.options.controller.provider(session.agent);
        if (!provider.deleteSession) throw aiSessionControlError("AI_SESSION_DELETE_UNSUPPORTED", `${session.agent} does not support provider deletion.`, 400);
        const providerAlreadyAbsent = providerAbsentIds.has(session.id);
        if (!providerAlreadyAbsent && active && (active.status === "running" || active.status === "waiting") && active.activeTurnId) {
          await this.options.controller.interrupt(active.id);
        }
        if (!providerAlreadyAbsent) {
          try {
            await provider.deleteSession(session.providerSessionId);
          } catch (deleteError: unknown) {
            let stillExists = true;
            if (provider.activeSessionExists) {
              try { stillExists = await provider.activeSessionExists(session.providerSessionId); } catch { /* Keep the delete error authoritative. */ }
            }
            if (stillExists) throw deleteError;
          }
        }
        if (active?.appSessionId) await this.options.stopApp(active.appSessionId);
        if (!providerAlreadyAbsent) await provider.unsubscribeSession?.(session.providerSessionId);
        if (active) this.options.registry.discard(active.id);
        const removedHistory = this.options.history.remove(session.id);
        if (!removedHistory) this.options.releaseSessionResources?.(session.id);
        clearedSessionIds.push(session.id);
      } catch (error: unknown) {
        firstError ||= error;
        if (active) this.options.registry.restoreAuthority(active);
        let node = forest.nodesById.get(session.id);
        while (node?.parentSessionId) {
          blocked.add(node.parentSessionId);
          node = forest.nodesById.get(node.parentSessionId);
        }
        this.options.onDiagnostic?.({
          code: "AI_SESSION_SUBTREE_DELETE_FAILED",
          aiSessionId: session.id,
          providerSessionId: session.providerSessionId,
          blockedAncestorIds: [...blocked],
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (firstError) throw aiSessionControlError(
      "AI_SESSION_DELETE_FAILED",
      firstError instanceof Error ? firstError.message : "AI session subtree could not be deleted.",
      409,
    );
    return AiSessionClearResultSchema.parse({ disposition: "cleared", aiSessionId: target.id, clearedSessionIds });
  }

  private keys(session: AiSessionStatus) {
    return [`ai:${session.id}`, `provider:${session.agent}:${session.providerSessionId || "missing"}`];
  }
}
