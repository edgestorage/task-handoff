import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  AiSessionRenameInputSchema,
  AiSessionRenameResultSchema,
  type AiSessionRenameInput,
  type AiSessionRenameResult,
  type AiSessionStatus,
} from "@task-handoff/protocol/ai-sessions";
import { aiSessionControlError, type AiSessionController } from "./ai-session-control";
import type { AiSessionRegistry } from "./ai-session-registry";

const SessionRenameIntentSchema = z.object({
  schemaVersion: z.literal(1),
  operationId: z.string().trim().min(1).max(160),
  clientRequestId: z.string().trim().min(1).max(160).optional(),
  aiSessionId: z.string().trim().min(1).max(120),
  agent: z.string().trim().min(1).max(80),
  providerSessionId: z.string().trim().min(1).max(240).optional(),
  appSessionId: z.string().trim().min(1).max(120),
  previousTitle: z.string().trim().max(240).optional(),
  targetTitle: z.string().trim().max(120),
  authority: z.enum(["provider", "app-session"]),
  phase: z.enum(["prepared", "authority-confirmed", "replica-confirmed", "conflicted"]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strip();

export type SessionRenameIntent = z.infer<typeof SessionRenameIntentSchema>;

const SessionRenameIntentFileSchema = z.object({
  schemaVersion: z.literal(1),
  intents: z.array(z.unknown()).max(1000).default([]),
}).strip();

export class SessionRenameIntentStore {
  private readonly filePath: string;
  private readonly intents = new Map<string, SessionRenameIntent>();

  constructor(
    dataDir: string,
    private readonly onWarning: (warning: Record<string, unknown>) => void = () => undefined,
  ) {
    this.filePath = path.join(dataDir, "ai-session-renames", "intents.json");
    this.load();
  }

  list() {
    return [...this.intents.values()];
  }

  get(operationId: string) {
    return this.intents.get(operationId);
  }

  findByClientRequestId(clientRequestId: string) {
    return this.list().find((intent) => intent.clientRequestId === clientRequestId);
  }

  put(intent: SessionRenameIntent) {
    const parsed = SessionRenameIntentSchema.parse(intent);
    this.intents.set(parsed.operationId, parsed);
    this.persist();
    return parsed;
  }

  remove(operationId: string) {
    if (!this.intents.delete(operationId)) return false;
    this.persist();
    return true;
  }

  private load() {
    if (!fs.existsSync(this.filePath)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      const file = SessionRenameIntentFileSchema.safeParse(raw);
      if (!file.success) {
        this.onWarning({ code: "AI_SESSION_RENAME_INTENT_FILE_INVALID", issues: file.error.issues });
        return;
      }
      for (const candidate of file.data.intents) {
        const parsed = SessionRenameIntentSchema.safeParse(candidate);
        if (parsed.success) this.intents.set(parsed.data.operationId, parsed.data);
        else this.onWarning({ code: "AI_SESSION_RENAME_INTENT_INVALID", issues: parsed.error.issues });
      }
    } catch (error) {
      this.onWarning({ code: "AI_SESSION_RENAME_INTENT_READ_FAILED", error: error instanceof Error ? error.message : String(error) });
    }
  }

  private persist() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify({ schemaVersion: 1, intents: this.list() }, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, this.filePath);
  }
}

type AppSessionRecord = { id: string; title: string; [key: string]: unknown };

export type SessionTitleCoordinatorOptions = {
  registry: AiSessionRegistry;
  controller: AiSessionController;
  appRuntime: {
    getSession(id: string): AppSessionRecord | undefined;
    rename(id: string, title: string): AppSessionRecord;
  };
  intents: SessionRenameIntentStore;
  isAppDerivedTitle?: (session: AiSessionStatus) => boolean;
  isIndependentTitle?: (session: AiSessionStatus) => boolean;
  onDiagnostic?: (diagnostic: Record<string, unknown>) => void;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
};

export class SessionTitleCoordinator {
  private readonly locks = new Map<string, Promise<void>>();
  private readonly retryAttempts = new Map<string, number>();
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly options: SessionTitleCoordinatorOptions) {}

  renameAiSession(sessionId: string, input: AiSessionRenameInput) {
    const parsed = AiSessionRenameInputSchema.parse(input);
    const session = this.requireSession(sessionId);
    const existing = this.options.intents.findByClientRequestId(parsed.clientRequestId);
    if (existing) {
      if (existing.aiSessionId !== sessionId || existing.targetTitle !== parsed.title) {
        throw aiSessionControlError("AI_SESSION_RENAME_REQUEST_CONFLICT", "The client request id is already bound to another rename.", 409);
      }
      return this.resumeIntent(existing);
    }
    return this.runLocked(this.operationKey(session), () => this.renameBoundSession(session.id, parsed));
  }

  renameAppSession(appSessionId: string, title: string, input: { expectedTitle?: string; clientRequestId?: string } = {}) {
    const linked = this.sessionsForApp(appSessionId);
    if (linked.length > 1) throw this.bindingConflict(appSessionId, linked);
    if (!linked.length) return Promise.resolve(this.options.appRuntime.rename(appSessionId, title));
    if (this.isIndependent(linked[0])) return Promise.resolve(this.options.appRuntime.rename(appSessionId, title));
    const clientRequestId = input.clientRequestId || `legacy_app_rename_${randomUUID()}`;
    return this.renameAiSession(linked[0].id, {
      title,
      clientRequestId,
      ...(input.expectedTitle !== undefined ? { expectedTitle: input.expectedTitle } : {}),
    }).then(() => this.requireAppSession(appSessionId));
  }

  async observeProviderTitle(sessionId: string) {
    const session = this.options.registry.get(sessionId);
    if (!session?.appSessionId || !session.title || this.isAppDerived(session) || this.isIndependent(session)) return;
    await this.runLocked(this.operationKey(session), async () => {
      const currentSession = this.requireSession(session.id);
      const linked = this.sessionsForApp(session.appSessionId!);
      if (linked.length > 1) throw this.bindingConflict(session.appSessionId!, linked);
      const appSession = this.options.appRuntime.getSession(session.appSessionId!);
      if (!appSession || !currentSession.title || appSession.title === currentSession.title) return;
      const active = this.options.intents.list().find((intent) => intent.aiSessionId === currentSession.id);
      if (active?.targetTitle === currentSession.title) {
        await this.resumeIntent(active);
        return;
      }
      if (active) {
        this.diagnoseIntent("AI_SESSION_RENAME_SUPERSEDED", active, { title: currentSession.title });
        this.completeIntent(active.operationId);
      }
      const timestamp = new Date().toISOString();
      const intent = this.options.intents.put({
        schemaVersion: 1,
        operationId: `rename_${randomUUID()}`,
        aiSessionId: currentSession.id,
        agent: currentSession.agent,
        providerSessionId: currentSession.providerSessionId,
        appSessionId: appSession.id,
        previousTitle: appSession.title,
        targetTitle: currentSession.title,
        authority: "provider",
        phase: "authority-confirmed",
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      this.diagnoseIntent("AI_SESSION_RENAME_PREPARED", intent, { source: "provider-observation" });
      await this.resumeIntent(intent);
    });
  }

  async observeAppSessionTitle(appSessionId: string) {
    const linked = this.sessionsForApp(appSessionId);
    if (!linked.length) return;
    if (linked.length > 1) {
      this.options.onDiagnostic?.({ code: "AI_SESSION_RENAME_BINDING_CONFLICT", appSessionId, aiSessionIds: linked.map((session) => session.id) });
      return;
    }
    const session = linked[0];
    if (this.isIndependent(session)) return;
    const appSession = this.options.appRuntime.getSession(appSessionId);
    if (!appSession || session.title === appSession.title) return;
    if (this.isAppDerived(session)) {
      this.projectAppDerivedTitle(session, appSession.title);
      return;
    }
    await this.renameAiSession(session.id, {
      title: appSession.title,
      expectedTitle: session.title,
      clientRequestId: `observed_app_rename_${appSessionId}_${appSession.title}`,
    }).catch((error) => this.options.onDiagnostic?.({
      code: "AI_SESSION_RENAME_APP_OBSERVATION_FAILED",
      appSessionId,
      aiSessionId: session.id,
      error: error instanceof Error ? error.message : String(error),
    }));
  }

  async recover() {
    for (const intent of this.options.intents.list()) {
      await this.resumeIntent(intent).catch((error) => {
        this.options.onDiagnostic?.({
          code: "AI_SESSION_RENAME_RECOVERY_FAILED",
          operationId: intent.operationId,
          aiSessionId: intent.aiSessionId,
          appSessionId: intent.appSessionId,
          error: error instanceof Error ? error.message : String(error),
        });
        this.scheduleRetry(intent.operationId);
      });
    }
  }

  private renameBoundSession(sessionId: string, input: AiSessionRenameInput): Promise<AiSessionRenameResult> {
    const session = this.requireSession(sessionId);
    if (session.actions?.rename !== true) {
      throw aiSessionControlError("AI_SESSION_RENAME_UNSUPPORTED", "This AI session does not support renaming.", 409);
    }
    if (this.isIndependent(session)) return this.renameIndependent(session, input);
    const appSession = session.appSessionId ? this.options.appRuntime.getSession(session.appSessionId) : undefined;
    const authority = this.isAppDerived(session) ? "app-session" as const : "provider" as const;
    const currentTitle = authority === "app-session" ? appSession?.title : session.title;
    if (input.expectedTitle !== undefined && input.expectedTitle !== (currentTitle || "")) {
      throw aiSessionControlError("AI_SESSION_RENAME_CONFLICT", "The session title changed before the rename was applied.", 409);
    }
    if (currentTitle === input.title && (!appSession || appSession.title === input.title) && session.title === input.title) {
      return Promise.resolve(AiSessionRenameResultSchema.parse({ disposition: "already-named", aiSessionId: session.id, appSessionId: session.appSessionId, title: input.title }));
    }
    if (!appSession) return this.renameUnbound(session, input.title);

    const timestamp = new Date().toISOString();
    const intent = this.options.intents.put({
      schemaVersion: 1,
      operationId: `rename_${randomUUID()}`,
      clientRequestId: input.clientRequestId,
      aiSessionId: session.id,
      agent: session.agent,
      providerSessionId: session.providerSessionId,
      appSessionId: appSession.id,
      previousTitle: currentTitle,
      targetTitle: input.title,
      authority,
      phase: "prepared",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    this.diagnoseIntent("AI_SESSION_RENAME_PREPARED", intent);
    return this.resumeIntent(intent);
  }

  private async renameIndependent(session: AiSessionStatus, input: AiSessionRenameInput) {
    const currentTitle = session.title || "";
    if (input.expectedTitle !== undefined && input.expectedTitle !== currentTitle) {
      throw aiSessionControlError("AI_SESSION_RENAME_CONFLICT", "The session title changed before the rename was applied.", 409);
    }
    if (currentTitle === input.title) {
      return AiSessionRenameResultSchema.parse({
        disposition: "already-named",
        aiSessionId: session.id,
        appSessionId: session.appSessionId,
        title: input.title,
      });
    }
    const result = await this.options.controller.renameSession(session.id, input.title);
    return AiSessionRenameResultSchema.parse({
      disposition: "renamed",
      aiSessionId: session.id,
      appSessionId: session.appSessionId,
      title: result.title,
    });
  }

  private async renameUnbound(session: AiSessionStatus, title: string) {
    if (this.isAppDerived(session) || session.actions?.rename !== true) {
      throw aiSessionControlError("AI_SESSION_RENAME_UNSUPPORTED", "This AI session does not support renaming.", 409);
    }
    const operationId = `rename_${randomUUID()}`;
    this.options.onDiagnostic?.({ code: "AI_SESSION_RENAME_PREPARED", operationId, aiSessionId: session.id, agent: session.agent, providerSessionId: session.providerSessionId, targetTitle: title });
    try {
      const result = await this.options.controller.renameSession(session.id, title);
      this.options.onDiagnostic?.({ code: "AI_SESSION_RENAME_COMPLETED", operationId, aiSessionId: session.id, agent: session.agent, providerSessionId: session.providerSessionId, title: result.title });
      return AiSessionRenameResultSchema.parse({ disposition: "renamed", aiSessionId: session.id, title: result.title });
    } catch (error) {
      this.options.onDiagnostic?.({ code: "AI_SESSION_RENAME_FAILED", operationId, aiSessionId: session.id, agent: session.agent, providerSessionId: session.providerSessionId, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  private resumeIntent(intent: SessionRenameIntent) {
    const key = `intent:${intent.operationId}`;
    return this.runLocked(key, async () => {
      const current = this.options.intents.get(intent.operationId);
      if (!current) {
        const session = this.requireSession(intent.aiSessionId);
        return AiSessionRenameResultSchema.parse({ disposition: session.title === intent.targetTitle ? "already-named" : "renamed", aiSessionId: session.id, appSessionId: session.appSessionId, title: session.title || intent.targetTitle });
      }
      const session = this.requireSession(current.aiSessionId);
      const appSession = this.requireAppSession(current.appSessionId);
      let progress = current;
      try {
        const authorityTitle = current.authority === "provider" ? session.title : appSession.title;
        if (authorityTitle && authorityTitle !== current.targetTitle && authorityTitle !== current.previousTitle) {
          if (current.authority === "provider" && appSession.title !== authorityTitle) this.options.appRuntime.rename(appSession.id, authorityTitle);
          if (current.authority === "app-session" && session.title !== authorityTitle) this.projectAppDerivedTitle(session, authorityTitle);
          this.diagnoseIntent("AI_SESSION_RENAME_SUPERSEDED", current, { title: authorityTitle });
          this.completeIntent(current.operationId);
          return AiSessionRenameResultSchema.parse({
            disposition: "renamed",
            aiSessionId: session.id,
            appSessionId: appSession.id,
            title: authorityTitle,
          });
        }
        if (current.authority === "provider") {
          if (session.title !== current.targetTitle) await this.options.controller.renameSession(session.id, current.targetTitle);
          progress = this.updateIntent(current, "authority-confirmed");
          if (appSession.title !== current.targetTitle) this.options.appRuntime.rename(appSession.id, current.targetTitle);
        } else {
          if (appSession.title !== current.targetTitle) this.options.appRuntime.rename(appSession.id, current.targetTitle);
          progress = this.updateIntent(current, "authority-confirmed");
          if (session.title !== current.targetTitle) this.projectAppDerivedTitle(session, current.targetTitle);
        }
        const confirmedSession = this.requireSession(current.aiSessionId);
        const confirmedApp = this.requireAppSession(current.appSessionId);
        if (confirmedSession.title !== current.targetTitle || confirmedApp.title !== current.targetTitle) {
          throw aiSessionControlError("AI_SESSION_RENAME_PENDING", "Session title synchronization is still pending.", 503);
        }
        this.updateIntent(current, "replica-confirmed");
        this.diagnoseIntent("AI_SESSION_RENAME_COMPLETED", current, { title: current.targetTitle });
        this.completeIntent(current.operationId);
        return AiSessionRenameResultSchema.parse({ disposition: "renamed", aiSessionId: confirmedSession.id, appSessionId: confirmedApp.id, title: current.targetTitle });
      } catch (error) {
        const record = error && typeof error === "object" ? error as Record<string, unknown> : {};
        const uncertain = record.code === "AI_SESSION_RENAME_NOT_CONFIRMED" || (typeof record.statusCode === "number" && record.statusCode >= 500);
        if (progress.phase === "prepared" && !uncertain) this.options.intents.remove(current.operationId);
        else if (this.options.intents.get(current.operationId)) this.scheduleRetry(current.operationId);
        this.diagnoseIntent("AI_SESSION_RENAME_FAILED", current, { phase: progress.phase, error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    });
  }

  private completeIntent(operationId: string) {
    const timer = this.retryTimers.get(operationId);
    if (timer) clearTimeout(timer);
    this.retryTimers.delete(operationId);
    this.retryAttempts.delete(operationId);
    this.options.intents.remove(operationId);
  }

  private scheduleRetry(operationId: string) {
    if (this.retryTimers.has(operationId) || !this.options.intents.get(operationId)) return;
    const attempt = this.retryAttempts.get(operationId) || 0;
    const base = Math.max(10, this.options.retryBaseDelayMs ?? 1_000);
    const maximum = Math.max(base, this.options.retryMaxDelayMs ?? 30_000);
    const delay = Math.min(maximum, base * (2 ** Math.min(attempt, 8)));
    this.retryAttempts.set(operationId, attempt + 1);
    const timer = setTimeout(() => {
      this.retryTimers.delete(operationId);
      const intent = this.options.intents.get(operationId);
      if (!intent) return;
      void this.resumeIntent(intent).catch((error) => {
        this.options.onDiagnostic?.({
          code: "AI_SESSION_RENAME_RETRY_FAILED",
          operationId,
          aiSessionId: intent.aiSessionId,
          appSessionId: intent.appSessionId,
          attempt: attempt + 1,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, delay);
    timer.unref?.();
    this.retryTimers.set(operationId, timer);
  }

  private diagnoseIntent(code: string, intent: SessionRenameIntent, extra: Record<string, unknown> = {}) {
    this.options.onDiagnostic?.({
      code,
      operationId: intent.operationId,
      clientRequestId: intent.clientRequestId,
      aiSessionId: intent.aiSessionId,
      appSessionId: intent.appSessionId,
      agent: intent.agent,
      providerSessionId: intent.providerSessionId,
      authority: intent.authority,
      targetTitle: intent.targetTitle,
      ...extra,
    });
  }

  private updateIntent(intent: SessionRenameIntent, phase: SessionRenameIntent["phase"]) {
    return this.options.intents.put({ ...intent, phase, updatedAt: new Date().toISOString() });
  }

  private projectAppDerivedTitle(session: AiSessionStatus, title: string) {
    this.options.registry.applyAdapterSnapshot({
      source: "adapter-snapshot",
      agent: session.agent,
      appId: session.appId,
      appSessionId: session.appSessionId,
      providerSessionId: session.providerSessionId,
      title,
    });
  }

  private runLocked<T>(key: string, run: () => Promise<T> | T): Promise<T> {
    const previous = this.locks.get(key) || Promise.resolve();
    const operation = previous.catch(() => undefined).then(run);
    const tail = operation.then(() => undefined, () => undefined).finally(() => {
      if (this.locks.get(key) === tail) this.locks.delete(key);
    });
    this.locks.set(key, tail);
    return operation;
  }

  private operationKey(session: AiSessionStatus) {
    return [session.id, session.agent, session.providerSessionId, session.appSessionId].filter(Boolean).join(":");
  }

  private sessionsForApp(appSessionId: string) {
    return this.options.registry.all().filter((session) => session.appSessionId === appSessionId);
  }

  private requireSession(sessionId: string) {
    const session = this.options.registry.get(sessionId);
    if (!session) throw aiSessionControlError("AI_SESSION_NOT_FOUND", "AI session not found.", 404);
    return session;
  }

  private requireAppSession(appSessionId: string) {
    const session = this.options.appRuntime.getSession(appSessionId);
    if (!session) throw aiSessionControlError("APP_SESSION_NOT_FOUND", "App session not found.", 404);
    return session;
  }

  private isAppDerived(session: AiSessionStatus) {
    return this.options.isAppDerivedTitle?.(session) === true;
  }

  private isIndependent(session: AiSessionStatus) {
    return this.options.isIndependentTitle?.(session) === true;
  }

  private bindingConflict(appSessionId: string, sessions: AiSessionStatus[]) {
    this.options.onDiagnostic?.({ code: "AI_SESSION_RENAME_BINDING_CONFLICT", appSessionId, aiSessionIds: sessions.map((session) => session.id) });
    return aiSessionControlError("AI_SESSION_RENAME_BINDING_CONFLICT", "App session is associated with multiple AI sessions.", 409);
  }
}
