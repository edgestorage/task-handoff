import { AiSessionOpenAppResultSchema, type AiSessionOpenAppResult, type AiSessionStatus } from "@task-handoff/protocol/ai-sessions";
import { aiSessionControlError } from "./ai-session-control";
import type { AiSessionRegistry } from "./ai-session-registry";

export type AiSessionOpenAppCoordinatorOptions = {
  registry: AiSessionRegistry;
  appSessions: () => readonly { id: string; status?: string }[];
  startApp: (session: AiSessionStatus) => { id: string; status?: string } | Promise<{ id: string; status?: string }>;
  stopApp: (appSessionId: string) => void | Promise<void>;
  bindingTimeoutMs?: number;
};

export class AiSessionOpenAppCoordinator {
  private readonly pending = new Map<string, Promise<AiSessionOpenAppResult>>();

  constructor(private readonly options: AiSessionOpenAppCoordinatorOptions) {}

  open(aiSessionId: string): Promise<AiSessionOpenAppResult> {
    const session = this.requireSession(aiSessionId);
    const keys = this.keys(session);
    const active = keys.map((key) => this.pending.get(key)).find(Boolean);
    if (active) return active;
    const promise = this.perform(session).finally(() => {
      for (const key of keys) if (this.pending.get(key) === promise) this.pending.delete(key);
    });
    for (const key of keys) this.pending.set(key, promise);
    return promise;
  }

  private async perform(session: AiSessionStatus): Promise<AiSessionOpenAppResult> {
    if (session.appSessionId && this.runningAppIds().has(session.appSessionId)) {
      return this.result("already-open", session, session.appSessionId);
    }
    if (!session.providerSessionId || !session.cwd) {
      throw aiSessionControlError("AI_SESSION_OPEN_APP_UNAVAILABLE", "AI session has no resumable provider identity or cwd.", 409);
    }
    let started: { id: string; status?: string } | undefined;
    try {
      started = await this.options.startApp(session);
      if (!started?.id || (started.status && started.status !== "running")) {
        throw new Error("App runtime did not create a running session.");
      }
      const bound = await this.waitForBinding(session, started.id);
      return this.result("opened", bound, started.id);
    } catch (error: unknown) {
      if (started?.id) {
        try { await this.options.stopApp(started.id); } catch { /* best effort compensation */ }
      }
      throw aiSessionControlError(
        "AI_SESSION_OPEN_APP_FAILED",
        error instanceof Error ? error.message : "App could not resume the AI session.",
        409,
      );
    }
  }

  private waitForBinding(session: AiSessionStatus, appSessionId: string) {
    const current = this.matchingBinding(session, appSessionId);
    if (current) return Promise.resolve(current);
    return new Promise<AiSessionStatus>((resolve, reject) => {
      const timeout = setTimeout(() => {
        unsubscribe();
        reject(new Error("Timed out waiting for the App to bind the original provider session."));
      }, this.options.bindingTimeoutMs ?? 8_000);
      const unsubscribe = this.options.registry.onChange(() => {
        const bound = this.matchingBinding(session, appSessionId);
        if (!bound) return;
        clearTimeout(timeout);
        unsubscribe();
        resolve(bound);
      });
    });
  }

  private matchingBinding(session: AiSessionStatus, appSessionId: string) {
    const current = this.options.registry.getByProviderSessionId(session.agent, session.providerSessionId || "");
    return current?.id === session.id && current.appSessionId === appSessionId ? current : undefined;
  }

  private result(disposition: "opened" | "already-open", session: AiSessionStatus, appSessionId: string) {
    return AiSessionOpenAppResultSchema.parse({
      disposition,
      aiSessionId: session.id,
      providerSessionId: session.providerSessionId,
      appSessionId,
      creationSource: session.creationSource,
    });
  }

  private requireSession(id: string) {
    const session = this.options.registry.get(id);
    if (!session) throw aiSessionControlError("AI_SESSION_NOT_FOUND", "AI session not found.", 404);
    return session;
  }

  private runningAppIds() {
    return new Set(this.options.appSessions().filter((app) => !app.status || app.status === "running").map((app) => app.id));
  }

  private keys(session: AiSessionStatus) {
    return [`ai:${session.id}`, `provider:${session.agent}:${session.providerSessionId || "missing"}`];
  }
}
