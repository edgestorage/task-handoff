import {
  STORY_CONTEXT_RESOLVE_PROTOCOL_VERSION,
  STORY_CONTEXT_SESSION_CANDIDATE_LIMIT,
  STORY_CONTEXT_SESSION_LAST_RESPONSE_MAX_LENGTH,
  STORY_CONTEXT_SESSION_TITLE_MAX_LENGTH,
  STORY_CONTEXT_SESSION_USER_PROMPT_MAX_LENGTH,
  StoryContextResolutionSchema,
  renderStoryContext,
  sanitizeStoryContextClosedSessionResult,
  type StoryContextDiagnostic,
  type StoryContextPurpose,
  type StoryContextResolveInput,
  type StoryContextResolution,
  type StoryContextSessionDiagnostic,
  type StoryContextSessionSummary,
} from "@task-handoff/protocol/story-context";
import type { AiSessionSummary } from "@task-handoff/protocol/ai-sessions";
import type { ControlledInstance } from "@task-handoff/protocol/control-plane";
import type { NodeAgentState } from "../state.ts";
import type { StoryContextSettingsService } from "./context-settings-service.ts";

const DEFAULT_CLOSED_SESSION_TIMEOUT_MS = 3_500;
const TRUNCATION_MARKER = "… [truncated]";

export type StoryContextResolutionServiceOptions = {
  state: NodeAgentState;
  settings: StoryContextSettingsService;
  fetchImpl?: typeof fetch;
  resolveInstanceWeb: (instance: ControlledInstance) => Promise<string>;
  listAgentRunMemberSessionIds?: () => readonly string[];
  closedSessionTimeoutMs?: number;
  log?: (diagnostic: StoryContextDiagnostic) => void;
};

type SessionCandidate = {
  instanceId: string;
  sessionId: string;
  summary: StoryContextSessionSummary;
};

function truncate(value: string | undefined, maxLength: number) {
  if (!value) return undefined;
  if (value.length <= maxLength) return value;
  if (maxLength <= TRUNCATION_MARKER.length) return value.slice(0, maxLength);
  return `${value.slice(0, maxLength - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`;
}

function diagnostic(code: string, message: string, resourceId?: string): StoryContextDiagnostic {
  return { code, message, ...(resourceId ? { resourceId } : {}) };
}

function sessionDiagnosticCode(diagnostic: StoryContextSessionDiagnostic) {
  return `story-context-session-${diagnostic.code}`;
}

function sessionDiagnosticMessage(diagnostic: StoryContextSessionDiagnostic) {
  const target = diagnostic.sessionId ? `Session ${diagnostic.sessionId}` : "An AI Session";
  if (diagnostic.code === "read-failed") return `${target} could not be read from its controlled instance.`;
  if (diagnostic.code === "unavailable") return `${target} instance is unavailable.`;
  if (diagnostic.code === "not-root") return `${target} is not a root AI Session.`;
  if (diagnostic.code === "wrong-story") return `${target} belongs to another Story.`;
  return `${target} returned an invalid Story context summary.`;
}

function activeSessionSummary(session: AiSessionSummary): StoryContextSessionSummary {
  const lastResponse = truncate(
    session.lastMessage || session.summary,
    STORY_CONTEXT_SESSION_LAST_RESPONSE_MAX_LENGTH,
  );
  return {
    instanceId: "",
    sessionId: session.id,
    ...(truncate(session.title, STORY_CONTEXT_SESSION_TITLE_MAX_LENGTH) ? { title: truncate(session.title, STORY_CONTEXT_SESSION_TITLE_MAX_LENGTH) } : {}),
    agent: session.agent,
    status: session.status,
    ...(truncate(session.userPrompt, STORY_CONTEXT_SESSION_USER_PROMPT_MAX_LENGTH)
      ? { userPrompt: truncate(session.userPrompt, STORY_CONTEXT_SESSION_USER_PROMPT_MAX_LENGTH) }
      : {}),
    ...(lastResponse ? { lastResponse } : {}),
    lastActivityAt: session.updatedAt,
  };
}

function candidateKey(instanceId: string, sessionId: string) {
  return `${instanceId}\u0000${sessionId}`;
}

function compareCandidates(left: SessionCandidate, right: SessionCandidate) {
  return right.summary.lastActivityAt.localeCompare(left.summary.lastActivityAt)
    || left.instanceId.localeCompare(right.instanceId)
    || left.sessionId.localeCompare(right.sessionId);
}

async function withTimeout<T>(timeoutMs: number, operation: (signal: AbortSignal) => Promise<T>) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(Object.assign(new Error("Story context history read timed out."), { code: "STORY_CONTEXT_SESSION_READ_TIMEOUT" }));
        }, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Resolves Story context exclusively on the owner Node Agent. Controlled instances consume the
 * rendered text and must not maintain a second renderer.
 */
export class StoryContextResolutionService {
  private readonly state: NodeAgentState;
  private readonly settings: StoryContextSettingsService;
  private readonly fetchImpl: typeof fetch;
  private readonly resolveInstanceWeb: (instance: ControlledInstance) => Promise<string>;
  private readonly listAgentRunMemberSessionIds: () => readonly string[];
  private readonly closedSessionTimeoutMs: number;
  private readonly log?: (diagnostic: StoryContextDiagnostic) => void;

  constructor(options: StoryContextResolutionServiceOptions) {
    this.state = options.state;
    this.settings = options.settings;
    this.fetchImpl = options.fetchImpl || fetch;
    this.resolveInstanceWeb = options.resolveInstanceWeb;
    this.listAgentRunMemberSessionIds = options.listAgentRunMemberSessionIds || (() => []);
    this.closedSessionTimeoutMs = options.closedSessionTimeoutMs || DEFAULT_CLOSED_SESSION_TIMEOUT_MS;
    this.log = options.log;
  }

  async resolve(input: StoryContextResolveInput): Promise<StoryContextResolution> {
    const settings = await this.settings.get(input.storyId);
    const diagnostics: StoryContextDiagnostic[] = [];
    const projects = settings.projectFolderIds.flatMap((folderId) => {
      const folder = this.state.resolveLocalFolder(folderId);
      if (!folder || folder.nodeId !== this.state.node.id) {
        diagnostics.push(diagnostic(
          "story-context-project-missing",
          `Story project ${folderId} is no longer available on this Node and was omitted.`,
          folderId,
        ));
        return [];
      }
      return [{ folderId, name: folder.name, path: folder.path }];
    });

    const sessionCollection = input.purpose === "agent-run"
      ? await this.collectAgentRunSessions(input, diagnostics)
      : { sessions: [], windowOmittedCount: 0, closedOmittedCount: 0 };
    const rendered = renderStoryContext({
      storyId: input.storyId,
      revision: settings.revision,
      purpose: input.purpose,
      appendedPrompt: settings.appendedPrompt,
      projects,
      sessions: sessionCollection.sessions,
      diagnostics,
      omittedProjectCount: settings.projectFolderIds.length - projects.length,
      omittedSessionCount: sessionCollection.closedOmittedCount,
      sessionCandidateWindowOmittedCount: sessionCollection.windowOmittedCount,
    });
    for (const entry of rendered.diagnostics) this.log?.(entry);
    return StoryContextResolutionSchema.parse({
      protocolVersion: STORY_CONTEXT_RESOLVE_PROTOCOL_VERSION,
      storyId: input.storyId,
      nodeId: this.state.node.id,
      purpose: input.purpose,
      revision: settings.revision,
      renderedContext: rendered.renderedContext,
      diagnostics: rendered.diagnostics,
      omittedProjectCount: rendered.omittedProjectCount,
      omittedSessionCount: rendered.omittedSessionCount,
      sessionCandidateWindowOmittedCount: rendered.sessionCandidateWindowOmittedCount,
    });
  }

  private async collectAgentRunSessions(
    input: StoryContextResolveInput,
    diagnostics: StoryContextDiagnostic[],
  ): Promise<{ sessions: StoryContextSessionSummary[]; windowOmittedCount: number; closedOmittedCount: number }> {
    // Caller and Agent Run members are authoritative exclusions that must survive the wire
    // bound below; explicit input exclusions are the overflow. Insertion order therefore
    // prioritizes caller/member IDs before the caller-provided list.
    const prioritized = new Set<string>();
    if (input.caller?.sessionId) prioritized.add(input.caller.sessionId);
    try {
      for (const sessionId of this.listAgentRunMemberSessionIds()) prioritized.add(sessionId);
    } catch (error) {
      diagnostics.push(diagnostic(
        "story-context-agent-run-members-unavailable",
        `Agent Run member sessions could not be excluded: ${error instanceof Error ? error.message : String(error)}`,
      ));
    }
    const explicitExclusions = input.excludeSessionIds.filter((sessionId) => !prioritized.has(sessionId));
    const excluded = new Set<string>([...prioritized, ...explicitExclusions]);

    const candidates = new Map<string, SessionCandidate>();
    for (const instance of this.state.listInstances()) {
      for (const session of instance.aiSessions.sessions) {
        if (!this.isRootStorySession(session, input.storyId) || excluded.has(session.id)) continue;
        const summary = { ...activeSessionSummary(session), instanceId: instance.id };
        candidates.set(candidateKey(instance.id, session.id), {
          instanceId: instance.id,
          sessionId: session.id,
          summary,
        });
      }
    }

    // The caller and Agent Run members are added after the public input has already
    // passed its 200-item validation. The private request has the same wire bound, so
    // cap only what is sent upstream; the full set remains local for response filtering.
    const closedHistoryExcludeSessionIds = [...excluded].slice(0, STORY_CONTEXT_SESSION_CANDIDATE_LIMIT);
    const closed = await Promise.all(this.state.listInstances().map((instance) => this.readClosedSessions(instance, {
      ...input,
      excludeSessionIds: closedHistoryExcludeSessionIds,
    })));
    let closedOmittedCount = 0;
    for (const result of closed) {
      closedOmittedCount += result.omittedCount;
      for (const sessionDiagnostic of result.diagnostics) {
        diagnostics.push(diagnostic(
          sessionDiagnosticCode(sessionDiagnostic),
          sessionDiagnosticMessage(sessionDiagnostic),
          sessionDiagnostic.sessionId || sessionDiagnostic.instanceId,
        ));
      }
      for (const summary of result.sessions) {
        if (summary.instanceId !== result.instanceId
          || summary.sessionId === input.caller?.sessionId
          || excluded.has(summary.sessionId)) continue;
        const key = candidateKey(summary.instanceId, summary.sessionId);
        if (!candidates.has(key)) candidates.set(key, { instanceId: summary.instanceId, sessionId: summary.sessionId, summary });
      }
    }

    const sorted = [...candidates.values()].sort(compareCandidates);
    const limited = sorted.slice(0, STORY_CONTEXT_SESSION_CANDIDATE_LIMIT);
    return {
      sessions: limited.map((candidate) => candidate.summary),
      windowOmittedCount: Math.max(0, sorted.length - limited.length),
      closedOmittedCount,
    };
  }

  private isRootStorySession(session: AiSessionSummary, storyId: string) {
    return session.storyId === storyId && session.lineage?.kind !== "subagent";
  }

  private async readClosedSessions(instance: ControlledInstance, input: StoryContextResolveInput) {
    const unavailable = (): { instanceId: string; sessions: []; omittedCount: number; diagnostics: StoryContextSessionDiagnostic[] } => ({
      instanceId: instance.id,
      sessions: [],
      omittedCount: 0,
      diagnostics: [{ instanceId: instance.id, code: "unavailable" }],
    });
    if (!instance.registrationToken) return unavailable();
    try {
      const base = await this.resolveInstanceWeb(instance);
      const data = await withTimeout(this.closedSessionTimeoutMs, async (signal) => {
        const response = await this.fetchImpl(`${base}/api/internal/node-agent/story-ai-sessions/closed-summaries`, {
          method: "POST",
          signal,
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${instance.registrationToken}`,
          },
          body: JSON.stringify({
            storyId: input.storyId,
            excludeSessionIds: input.excludeSessionIds,
            limit: STORY_CONTEXT_SESSION_CANDIDATE_LIMIT,
          }),
        });
        const payload = await response.json().catch(() => ({})) as { data?: unknown; error?: { code?: string; message?: string } };
        if (!response.ok) {
          throw Object.assign(new Error(payload.error?.message || `Controlled instance returned HTTP ${response.status}.`), {
            code: payload.error?.code || "STORY_CONTEXT_SESSION_READ_FAILED",
          });
        }
        return sanitizeStoryContextClosedSessionResult(payload.data);
      });
      if (data.storyId !== input.storyId) {
        return {
          instanceId: instance.id,
          sessions: [],
          omittedCount: 0,
          diagnostics: [{ instanceId: instance.id, code: "wrong-story" as const }],
        };
      }
      return { instanceId: instance.id, sessions: data.sessions, omittedCount: data.omittedCount, diagnostics: data.diagnostics };
    } catch {
      return {
        instanceId: instance.id,
        sessions: [],
        omittedCount: 0,
        diagnostics: [{ instanceId: instance.id, code: "read-failed" as const }],
      };
    }
  }
}
