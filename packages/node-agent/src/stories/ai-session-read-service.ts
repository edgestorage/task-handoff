import type { AiSessionSummary, AiSessionTimelineItem } from "@task-handoff/protocol/ai-sessions";
import type { ControlledInstance } from "@task-handoff/protocol/control-plane";
import {
  StoryAgentAiSessionGetResultSchema,
  StoryAgentAiSessionListResultSchema,
  StoryAgentAiSessionTurnResultSchema,
  storyAgentPagination,
  sanitizeStoryAgentAiSessionInstanceReadResult,
  sanitizeStoryAgentAiSessionInstanceTurnResult,
} from "@task-handoff/protocol/story-agent-tools";
import type { NodeAgentState } from "../state.ts";

export type StoryAiSessionCaller = { instanceId: string; sessionId: string; storyId: string };

export class StoryAiSessionReadService {
  private readonly state: NodeAgentState;
  private readonly fetchImpl: typeof fetch;
  private readonly resolveInstanceWeb: (instance: ControlledInstance) => Promise<string>;

  constructor(
    state: NodeAgentState,
    fetchImpl: typeof fetch,
    resolveInstanceWeb: (instance: ControlledInstance) => Promise<string>,
  ) {
    this.state = state;
    this.fetchImpl = fetchImpl;
    this.resolveInstanceWeb = resolveInstanceWeb;
  }

  list(caller: StoryAiSessionCaller, page: number, pageSize: number) {
    const candidates = this.candidates(caller);
    const offset = (page - 1) * pageSize;
    return StoryAgentAiSessionListResultSchema.parse({
      sessions: candidates.slice(offset, offset + pageSize).map(({ instance, session }) => ({
        instanceId: instance.id,
        sessionId: session.id,
        title: session.title,
        agent: session.agent,
        status: session.status,
        updatedAt: session.updatedAt,
      })),
      pagination: storyAgentPagination(candidates.length, page, pageSize),
    });
  }

  async get(caller: StoryAiSessionCaller, instanceId: string, sessionId: string, page: number, pageSize: number) {
    const target = this.requireTarget(caller, instanceId, sessionId);
    const data = sanitizeStoryAgentAiSessionInstanceReadResult(await this.request(
      target.instance,
      `/api/internal/node-agent/story-ai-sessions/${encodeURIComponent(sessionId)}`,
    ));
    const turns = newestTurns(data.turnIndex.turns);
    const offset = (page - 1) * pageSize;
    return StoryAgentAiSessionGetResultSchema.parse({
      ref: { instanceId, sessionId },
      session: {
        cwd: data.detail.cwd,
        error: data.detail.error,
        modelName: data.detail.modelSelection?.modelName,
        reasoningEffort: data.detail.reasoningEffort,
      },
      turns: turns.slice(offset, offset + pageSize).map((turn) => ({
        id: turn.id,
        status: turn.status,
        phase: turn.phase,
        updatedAt: turn.updatedAt,
        completedAt: turn.completedAt,
      })),
      pagination: storyAgentPagination(turns.length, page, pageSize),
    });
  }

  async turn(caller: StoryAiSessionCaller, instanceId: string, sessionId: string, turnId: string, page: number, pageSize: number, maxTextChars: number) {
    const target = this.requireTarget(caller, instanceId, sessionId);
    const data = sanitizeStoryAgentAiSessionInstanceTurnResult(await this.request(
      target.instance,
      `/api/internal/node-agent/story-ai-sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}`,
    ));
    const turn = data.body.turn;
    const offset = (page - 1) * pageSize;
    return StoryAgentAiSessionTurnResultSchema.parse({
      ref: { instanceId, sessionId },
      turn: {
        id: turn.id,
        status: turn.status,
        phase: turn.phase,
        contextCompactions: turn.contextCompactions,
        startedAt: turn.startedAt,
        updatedAt: turn.updatedAt,
        completedAt: turn.completedAt,
      },
      items: data.timeline.items.slice(offset, offset + pageSize).map((item) => projectItem(item, maxTextChars)),
      pagination: storyAgentPagination(data.timeline.items.length, page, pageSize),
    });
  }

  private candidates(caller: StoryAiSessionCaller) {
    return this.state.listInstances().flatMap((instance) => instance.aiSessions.sessions.flatMap((session) => (
      this.inScope(caller, instance.id, session) ? [{ instance, session }] : []
    ))).sort((left, right) => (
      right.session.updatedAt.localeCompare(left.session.updatedAt)
      || left.instance.id.localeCompare(right.instance.id)
      || left.session.id.localeCompare(right.session.id)
    ));
  }

  private requireTarget(caller: StoryAiSessionCaller, instanceId: string, sessionId: string) {
    const candidate = this.candidates(caller).find(({ instance, session }) => instance.id === instanceId && session.id === sessionId);
    if (!candidate) throw readError("AI_SESSION_NOT_FOUND", "AI Session was not found.", 404);
    return candidate;
  }

  private inScope(caller: StoryAiSessionCaller, instanceId: string, session: AiSessionSummary) {
    return session.storyId === caller.storyId
      && session.lineage?.kind !== "subagent"
      && session.status !== "failed"
      && (instanceId !== caller.instanceId || session.id !== caller.sessionId);
  }

  private async request(instance: ControlledInstance, route: string) {
    if (!instance.registrationToken) throw readError("AI_SESSION_UNAVAILABLE", "AI Session instance is unavailable.", 503);
    let response: Response;
    try {
      response = await this.fetchImpl(`${await this.resolveInstanceWeb(instance)}${route}`, {
        headers: { authorization: `Bearer ${instance.registrationToken}` },
      });
    } catch (cause) {
      throw readError("AI_SESSION_UNAVAILABLE", "AI Session instance is unavailable.", 503, cause);
    }
    const payload = await response.json().catch(() => ({})) as { data?: unknown };
    if (!response.ok) {
      if (response.status === 404) throw readError("AI_SESSION_NOT_FOUND", "AI Session was not found.", 404);
      throw readError("AI_SESSION_READ_FAILED", "AI Session could not be read.", response.status);
    }
    return payload.data;
  }
}

function newestTurns<T extends { id: string; startedAt?: string; updatedAt?: string; completedAt?: string }>(turns: T[]) {
  return turns.map((turn, index) => ({ turn, index })).sort((left, right) => {
    const leftTime = [left.turn.startedAt, left.turn.updatedAt, left.turn.completedAt].filter(Boolean).sort().at(-1) || "";
    const rightTime = [right.turn.startedAt, right.turn.updatedAt, right.turn.completedAt].filter(Boolean).sort().at(-1) || "";
    return rightTime.localeCompare(leftTime) || right.index - left.index;
  }).map(({ turn }) => turn);
}

function projectItem(item: AiSessionTimelineItem, maxTextChars: number) {
  const truncatedFields: Array<"text" | "summary" | "input" | "output" | "paths"> = [];
  const text = (field: "text" | "summary" | "input" | "output", value?: string) => {
    if (value === undefined) return undefined;
    if (value.length <= maxTextChars) return value;
    truncatedFields.push(field);
    return value.slice(0, maxTextChars);
  };
  if (item.type === "user-message") return {
    id: item.id,
    type: item.type,
    text: text("text", item.text),
    attachments: item.attachments,
    ...(truncatedFields.length ? { truncatedFields } : {}),
  };
  if (item.type === "ai-message") return {
    id: item.id,
    type: item.type,
    text: text("text", item.text),
    ...(truncatedFields.length ? { truncatedFields } : {}),
  };
  const paths = item.paths?.slice(0, 100);
  if (item.paths && item.paths.length > 100) truncatedFields.push("paths");
  return {
    id: item.id,
    type: item.type,
    activityKind: item.activityKind,
    title: item.title,
    status: item.status,
    summary: text("summary", item.summary),
    input: text("input", item.input),
    output: text("output", item.output),
    paths,
    exitCode: item.exitCode,
    durationMs: item.durationMs,
    ...(truncatedFields.length ? { truncatedFields } : {}),
  };
}

function readError(code: string, message: string, statusCode: number, cause?: unknown) {
  return Object.assign(new Error(message), { code, statusCode, ...(cause === undefined ? {} : { cause }) });
}
