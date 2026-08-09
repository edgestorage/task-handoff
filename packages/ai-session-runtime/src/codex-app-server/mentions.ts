import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  AiSessionMentionCatalogSchema,
  AiSessionMentionFileSearchSchema,
  AiSessionReferenceSchema,
  type AiSessionMentionCandidate,
  type AiSessionMentionCatalog,
  type AiSessionMentionDiagnostic,
  type AiSessionMentionFileSearch,
  type AiSessionReference,
  type AiSessionStatus,
} from "@task-handoff/protocol/ai-sessions";
import { aiSessionControlError } from "../ai-session-control";
import type { CodexAppServerClientLike } from "./client/contract";
import type { JsonValue } from "./protocol/types";

type MentionOptions = {
  readyClient: () => Promise<CodexAppServerClientLike>;
  readyThreadClient?: (threadId: string) => Promise<CodexAppServerClientLike>;
  connectionEpoch: () => number;
};

type RawNotification = { method?: unknown; params?: unknown };

export class CodexAppServerMentions {
  private readonly cache = new Map<string, AiSessionMentionCatalog>();
  private attachedClient?: CodexAppServerClientLike;
  private readonly activeSearches = new Map<string, { stop: () => void }>();
  private readonly notification = (notification: RawNotification) => this.handleNotification(notification);

  constructor(private readonly options: MentionOptions) {}

  resetConnection() {
    this.cache.clear();
    for (const search of this.activeSearches.values()) search.stop();
    this.activeSearches.clear();
    this.detachClient();
  }

  async catalog(session: AiSessionStatus, options: { force?: boolean } = {}) {
    const context = this.requireContext(session);
    const client = await this.client(context.threadId);
    const cacheKey = `${this.options.connectionEpoch()}:${context.cwd}:${context.threadId}`;
    if (!options.force) {
      const cached = this.cache.get(cacheKey);
      if (cached) return cached;
    }
    const diagnostics: AiSessionMentionDiagnostic[] = [];
    const candidates: AiSessionMentionCandidate[] = [];
    const [skills, plugins, apps] = await Promise.allSettled([
      this.requireMethod(client.listSkills, "skills/list").call(client, context.cwd),
      this.requireMethod(client.listPlugins, "plugin/list").call(client, context.cwd),
      this.requireMethod(client.listApps, "app/list").call(client, context.threadId),
    ]);
    this.collect(skills, "skills", candidates, diagnostics, normalizeSkills);
    this.collect(plugins, "plugins", candidates, diagnostics, normalizePlugins);
    this.collect(apps, "apps", candidates, diagnostics, normalizeApps);
    const result = AiSessionMentionCatalogSchema.parse({
      sessionId: session.id,
      providerSessionId: context.threadId,
      cwd: context.cwd,
      candidates: dedupeCandidates(candidates),
      diagnostics,
    });
    this.cache.set(cacheKey, result);
    return result;
  }

  async validateReferences(session: AiSessionStatus, references: AiSessionReference[]) {
    const parsed = references.map((reference) => AiSessionReferenceSchema.parse(reference));
    if (!parsed.length) return [];
    const catalog = await this.catalog(session);
    const available = new Set(catalog.candidates
      .filter((candidate) => candidate.kind === "skill" || candidate.kind === "app" || candidate.kind === "plugin")
      .map((candidate) => `${candidate.kind}:${candidate.path}`));
    const unique = new Map<string, AiSessionReference>();
    for (const reference of parsed) {
      const key = `${reference.kind}:${reference.path}`;
      if (!available.has(key)) {
        throw aiSessionControlError("AI_SESSION_REFERENCE_UNAVAILABLE", `${reference.kind} reference is not available in the current Codex session: ${reference.name}`, 409);
      }
      if (!unique.has(key)) unique.set(key, reference);
    }
    return [...unique.values()];
  }

  async searchFiles(session: AiSessionStatus, query: string): Promise<AiSessionMentionFileSearch> {
    const context = this.requireContext(session);
    const client = await this.client();
    const start = this.requireMethod(client.startFuzzyFileSearch, "fuzzyFileSearch/sessionStart");
    const update = this.requireMethod(client.updateFuzzyFileSearch, "fuzzyFileSearch/sessionUpdate");
    const stop = this.requireMethod(client.stopFuzzyFileSearch, "fuzzyFileSearch/sessionStop");
    const contextKey = session.id;
    this.activeSearches.get(contextKey)?.stop();
    const requestId = `mention_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    let settled = false;
    let complete = false;
    let latest: AiSessionMentionCandidate[] = [];
    let resolveResult: (() => void) | undefined;
    const completed = new Promise<void>((resolve) => { resolveResult = resolve; });
    const onNotification = (notification: RawNotification) => {
      const params = asRecord(notification.params);
      if (params.sessionId !== requestId) return;
      if (notification.method === "fuzzyFileSearch/sessionUpdated" && params.query === query && Array.isArray(params.files)) {
        latest = normalizeFileResults(params.files, context.cwd);
      }
      if (notification.method === "fuzzyFileSearch/sessionCompleted") {
        complete = true;
        resolveResult?.();
      }
    };
    client.on("notification", onNotification);
    const finish = () => {
      if (settled) return;
      settled = true;
      client.off("notification", onNotification);
      void stop.call(client, requestId).catch(() => undefined);
      if (this.activeSearches.get(contextKey)?.stop === finish) this.activeSearches.delete(contextKey);
      resolveResult?.();
    };
    this.activeSearches.set(contextKey, { stop: finish });
    try {
      await start.call(client, requestId, context.cwd);
      await update.call(client, requestId, query);
      await Promise.race([completed, new Promise((resolve) => setTimeout(resolve, 1200))]);
      return AiSessionMentionFileSearchSchema.parse({ sessionId: session.id, cwd: context.cwd, query, requestId, candidates: latest, complete });
    } finally {
      finish();
    }
  }

  private async client(threadId?: string) {
    const client = threadId && this.options.readyThreadClient
      ? await this.options.readyThreadClient(threadId)
      : await this.options.readyClient();
    if (this.attachedClient !== client) {
      this.detachClient();
      this.attachedClient = client;
      client.on("notification", this.notification);
    }
    return client;
  }

  private detachClient() {
    this.attachedClient?.off("notification", this.notification);
    this.attachedClient = undefined;
  }

  private handleNotification(notification: RawNotification) {
    if (notification.method === "skills/changed" || notification.method === "app/list/updated" || notification.method === "plugin/list/updated") {
      this.cache.clear();
    }
  }

  private requireContext(session: AiSessionStatus) {
    if (session.agent !== "codex") throw aiSessionControlError("AI_SESSION_MENTIONS_UNSUPPORTED", "Mentions are only supported for Codex sessions.", 400);
    if (!session.providerSessionId) throw aiSessionControlError("AI_SESSION_THREAD_NOT_FOUND", "AI session is not bound to a Codex thread.", 409);
    if (!session.cwd || !path.isAbsolute(session.cwd)) throw aiSessionControlError("AI_SESSION_CWD_NOT_FOUND", "AI session has no accessible working directory.", 409);
    return { threadId: session.providerSessionId, cwd: path.resolve(session.cwd) };
  }

  private requireMethod<T extends (...args: never[]) => unknown>(method: T | undefined, name: string) {
    if (!method) throw aiSessionControlError("AI_SESSION_MENTIONS_UNSUPPORTED", `Codex app-server does not support ${name}.`, 409);
    return method;
  }

  private collect(
    result: PromiseSettledResult<JsonValue>,
    category: AiSessionMentionDiagnostic["category"],
    candidates: AiSessionMentionCandidate[],
    diagnostics: AiSessionMentionDiagnostic[],
    normalize: (value: JsonValue) => AiSessionMentionCandidate[],
  ) {
    if (result.status === "fulfilled") candidates.push(...normalize(result.value));
    else diagnostics.push({ category, code: "CATALOG_QUERY_FAILED", message: result.reason instanceof Error ? result.reason.message : String(result.reason) });
  }
}

function normalizeSkills(value: JsonValue) {
  return array(value.data).flatMap((entry) => array(asRecord(entry).skills)).flatMap((value) => {
    const skill = asRecord(value);
    if (skill.enabled !== true || typeof skill.name !== "string" || typeof skill.path !== "string" || !path.isAbsolute(skill.path)) return [];
    const details = asRecord(skill.interface);
    return [{ kind: "skill" as const, name: typeof details.displayName === "string" ? details.displayName : skill.name, description: text(details.shortDescription) || text(skill.shortDescription) || text(skill.description), path: skill.path }];
  });
}

function normalizePlugins(value: JsonValue) {
  return array(value.marketplaces).flatMap((entry) => array(asRecord(entry).plugins)).flatMap((value) => {
    const plugin = asRecord(value);
    if (plugin.installed !== true || plugin.enabled !== true || plugin.availability === "DISABLED_BY_ADMIN" || typeof plugin.id !== "string" || typeof plugin.name !== "string") return [];
    const details = asRecord(plugin.interface);
    return [{ kind: "plugin" as const, name: text(details.displayName) || plugin.name, description: text(details.shortDescription) || text(details.description), path: `plugin://${plugin.id}` }];
  });
}

function normalizeApps(value: JsonValue) {
  return array(value.data).flatMap((value) => {
    const app = asRecord(value);
    if (app.isAccessible !== true || app.isEnabled !== true || typeof app.id !== "string" || typeof app.name !== "string") return [];
    return [{ kind: "app" as const, name: app.name, description: text(app.description), path: `app://${app.id}`, icon: text(app.logoUrl) }];
  });
}

function normalizeFileResults(values: unknown[], cwd: string) {
  return values.flatMap((value) => {
    const file = asRecord(value);
    if (typeof file.path !== "string") return [];
    const absolute = path.isAbsolute(file.path) ? path.resolve(file.path) : path.resolve(cwd, file.path);
    const relative = path.relative(cwd, absolute);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return [];
    const matchType = String(file.match_type || file.matchType || "file").toLowerCase();
    return [{ kind: matchType === "directory" ? "directory" as const : "file" as const, name: text(file.file_name) || text(file.fileName) || path.basename(relative), path: relative.split(path.sep).join("/") }];
  }).slice(0, 200);
}

function dedupeCandidates(candidates: AiSessionMentionCandidate[]) {
  return [...new Map(candidates.map((candidate) => [`${candidate.kind}:${candidate.path}`, candidate])).values()];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
