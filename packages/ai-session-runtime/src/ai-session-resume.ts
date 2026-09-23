import {
  AiSessionResumeResultSchema,
  type AiSessionHistoryItem,
  type AiSessionModelSelection,
  type AiSessionResumeResult,
} from "@task-handoff/protocol/ai-sessions";
import type { StoryAgentToolName } from "@task-handoff/protocol/story-agent-tools";
import type { AiSessionRegistry } from "./ai-session-registry";
import type { AiSessionHistoryStore } from "./ai-session-history-store";

export type AiSessionResumeAppSession = {
  id: string;
  status?: string;
};

export type AiSessionResumeCoordinatorOptions = {
  history: AiSessionHistoryStore;
  registry: AiSessionRegistry;
  appSessions: () => readonly AiSessionResumeAppSession[];
  startApp: (item: AiSessionHistoryItem) => AiSessionResumeAppSession | Promise<AiSessionResumeAppSession>;
  resumeProvider?: (item: AiSessionHistoryItem, storyAgentTools?: StoryAgentToolName[]) => AiSessionModelSelection | void | Promise<AiSessionModelSelection | void>;
  resolveStoryAgentTools?: (item: AiSessionHistoryItem) => Promise<StoryAgentToolName[]>;
};

export class AiSessionResumeCoordinator {
  private readonly options: AiSessionResumeCoordinatorOptions;
  private readonly pending = new Map<string, Promise<AiSessionResumeResult>>();

  constructor(options: AiSessionResumeCoordinatorOptions) {
    this.options = options;
  }

  resume(aiSessionId: string, modelSelection?: AiSessionModelSelection) {
    const item = this.options.history.get(aiSessionId);
    if (!item) {
      throw resumeError("AI_SESSION_HISTORY_NOT_FOUND", "AI session history entry not found.", 404);
    }
    const keys = [`ai:${item.id}`, `provider:${item.agent}:${item.providerSessionId}`];
    const active = keys.map((key) => this.pending.get(key)).find(Boolean);
    if (active) return active;
    const promise = this.perform(item, modelSelection).finally(() => {
      for (const key of keys) {
        if (this.pending.get(key) === promise) this.pending.delete(key);
      }
    });
    for (const key of keys) this.pending.set(key, promise);
    return promise;
  }

  private async perform(item: AiSessionHistoryItem, requestedModelSelection?: AiSessionModelSelection): Promise<AiSessionResumeResult> {
    const resumeItem = requestedModelSelection ? { ...item, modelSelection: requestedModelSelection } : item;
    const runningAppIds = new Set(this.options.appSessions()
      .filter((session) => typeof session.status !== "string" || session.status === "running")
      .map((session) => session.id));
    const providerSession = this.options.registry.all().find((session) => (
      session.id === item.id
      || (session.agent === item.agent && session.providerSessionId === item.providerSessionId)
    ));
    if (providerSession?.appSessionId && runningAppIds.has(providerSession.appSessionId)) {
      return AiSessionResumeResultSchema.parse({
        disposition: "already-open",
        aiSessionId: providerSession.id,
        providerSessionId: item.providerSessionId,
        appSessionId: providerSession.appSessionId,
        creationSource: item.creationSource,
      });
    }

    const previous = this.options.registry.get(item.id);
    const previousProvider = providerSession?.id === item.id ? undefined : providerSession;
    if (providerSession && providerSession.id !== item.id) this.options.registry.discard(providerSession.id);
    this.options.registry.restoreHistory(resumeItem);
    try {
      if (item.creationSource === "ai-session") {
        if (!this.options.resumeProvider) throw new Error("Provider does not support direct AI session resume.");
        const storyAgentTools = item.storyId
          ? await this.options.resolveStoryAgentTools?.(item) || []
          : undefined;
        const actualModelSelection = await this.options.resumeProvider(resumeItem, storyAgentTools);
        if (requestedModelSelection && (!actualModelSelection
          || actualModelSelection.modelEntityId !== requestedModelSelection.modelEntityId
          || actualModelSelection.modelName !== requestedModelSelection.modelName)) {
          throw new Error("Provider resumed the session with a different model selection.");
        }
        this.options.history.activate(item.id);
        return AiSessionResumeResultSchema.parse({
          disposition: "resumed",
          aiSessionId: item.id,
          providerSessionId: item.providerSessionId,
          creationSource: item.creationSource,
        });
      }
      const appSession = await this.options.startApp(item);
      if (!appSession?.id || (typeof appSession.status === "string" && appSession.status !== "running")) {
        throw new Error("Provider resume did not create a running app session.");
      }
      return AiSessionResumeResultSchema.parse({
        disposition: "resumed",
        aiSessionId: item.id,
        providerSessionId: item.providerSessionId,
        appSessionId: appSession.id,
        creationSource: item.creationSource,
      });
    } catch (error: unknown) {
      if (!previous) this.options.registry.discard(item.id);
      else this.options.registry.restoreAuthority(previous);
      if (previousProvider) this.options.registry.restoreAuthority(previousProvider);
      throw resumeError(
        "AI_SESSION_RESUME_UNAVAILABLE",
        error instanceof Error ? error.message : "Provider session could not be resumed.",
        409,
        error,
      );
    }
  }
}

function resumeError(code: string, message: string, statusCode: number, cause?: unknown) {
  return Object.assign(new Error(message), { code, statusCode, ...(cause === undefined ? {} : { cause }) });
}
