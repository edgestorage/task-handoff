import crypto from "node:crypto";
import { z } from "zod";
import {
  StoryDecisionCancelInputSchema,
  StoryDecisionCreateInputSchema,
  StoryDecisionDecideInputSchema,
  StoryDecisionListSchema,
  StoryDecisionSchema,
  type StoryDecision,
  type StoryDecisionCancelInput,
  type StoryDecisionCreateInput,
  type StoryDecisionDecideInput,
  type StoryDecisionExpiredReason,
} from "@task-handoff/protocol/stories";
import { supportsAiSessionSendIdempotency, type ControlledInstance } from "@task-handoff/protocol/control-plane";
import type { NodeAgentState } from "../state.ts";
import type { NodeAgentRepository, StoryDecisionRecord } from "../persistence/repository.ts";
import type { StoryDecisionChangedEvent } from "@task-handoff/protocol/stories";

export type StoryDecisionCaller = { storyId: string; sessionId: string; turnId?: string };
export type StoryDecisionEventPublisher = (event: StoryDecisionChangedEvent) => void;

const InternalSendResultSchema = z.object({ turnId: z.string().trim().min(1).max(240).optional() }).strip();

export class StoryDecisionCommandService {
  private readonly state: NodeAgentState;
  private readonly repository: NodeAgentRepository;
  private readonly fetchImpl: typeof fetch;
  private readonly resolveInstanceWeb: (instance: ControlledInstance) => Promise<string>;
  private readonly publish?: StoryDecisionEventPublisher;

  constructor(
    state: NodeAgentState,
    repository: NodeAgentRepository,
    fetchImpl: typeof fetch,
    resolveInstanceWeb: (instance: ControlledInstance) => Promise<string>,
    publish?: StoryDecisionEventPublisher,
  ) {
    this.state = state;
    this.repository = repository;
    this.fetchImpl = fetchImpl;
    this.resolveInstanceWeb = resolveInstanceWeb;
    this.publish = publish;
  }

  async list(storyId: string) {
    await this.requireStory(storyId);
    const records = await this.repository.decisions.list(storyId);
    return StoryDecisionListSchema.parse({ decisions: records.map(projectDecision) });
  }

  async get(storyId: string, decisionId: string) {
    await this.requireStory(storyId);
    const record = await this.requireDecision(storyId, decisionId);
    return projectDecision(record);
  }

  async register(caller: StoryDecisionCaller, input: StoryDecisionCreateInput) {
    const parsed = StoryDecisionCreateInputSchema.parse(input);
    const story = await this.requireStory(caller.storyId);
    if (story.archivedAt) throw decisionError("STORY_ARCHIVED", "Archived Story cannot accept new decisions.", 409);
    // 登记必须校验发起会话属于同一 Story；不满足时拒绝且不创建对象。
    if (!this.findSessionInstance(caller.storyId, caller.sessionId)) {
      throw decisionError("STORY_DECISION_SESSION_SCOPE_MISMATCH", "The AI Session does not belong to the requested Story.", 409);
    }
    if (!caller.turnId) {
      throw decisionError("STORY_DECISION_TURN_REQUIRED", "The active AI Session turn could not be determined for the decision.", 409);
    }
    const existing = await this.repository.decisions.bySessionTurn(caller.storyId, caller.sessionId, caller.turnId);
    if (existing) {
      if (existing.status === "pending") return projectDecision(existing);
      throw decisionError("STORY_DECISION_CONFLICT", "A decision already exists for this AI Session turn.", 409);
    }
    const timestamp = new Date().toISOString();
    const record = await this.repository.decisions.insert({
      id: `story_decision_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
      storyId: caller.storyId,
      sessionId: caller.sessionId,
      turnId: caller.turnId,
      question: parsed.question,
      options: parsed.options || [],
      allowFreeText: parsed.allowFreeText ?? true,
      context: parsed.context,
      status: "pending",
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const decision = projectDecision(record);
    this.emit("created", decision);
    return decision;
  }

  async decide(storyId: string, decisionId: string, input: StoryDecisionDecideInput) {
    const parsed = StoryDecisionDecideInputSchema.parse(input);
    await this.assertStoryMutable(storyId);
    const decision = await this.requireDecision(storyId, decisionId);
    const options = decision.options || [];
    // 重复下达幂等：同一提交再次到达时返回首次成功派生的 decidedTurnId，不产生第二个 turn。
    if (decision.status === "decided" && sameDecisionReply(decision, parsed)) {
      return projectDecision(decision);
    }
    if (decision.status !== "pending") {
      throw decisionError("STORY_DECISION_TERMINAL", "The decision is no longer pending.", 409);
    }
    if (decision.revision !== parsed.expectedRevision) {
      throw decisionError("STORY_DECISION_REVISION_CONFLICT", "The decision was modified by another request.", 409);
    }
    if (parsed.optionId && !options.some((option) => option.id === parsed.optionId)) {
      throw decisionError("STORY_DECISION_OPTION_UNKNOWN", "The selected decision option does not exist.", 400);
    }
    if (!parsed.optionId && parsed.response && decision.allowFreeText === false) {
      throw decisionError("STORY_DECISION_FREE_TEXT_FORBIDDEN", "This decision does not accept a free-text response.", 400);
    }
    const target = this.findSessionInstance(decision.storyId, decision.sessionId);
    if (!target) throw decisionError("STORY_DECISION_SESSION_UNAVAILABLE", "The AI Session that raised the decision is unavailable.", 409);
    if (!target.registrationToken) throw decisionError("STORY_DECISION_SESSION_UNAVAILABLE", "The AI Session instance is unavailable.", 503);
    const message = composeDecisionResponse(decision, parsed);
    const idempotentSend = supportsAiSessionSendIdempotency(target.capabilities);
    const turnId = idempotentSend
      ? await this.dispatchResponse(target, decision, message, decision.id)
      : await this.dispatchWithResumingLedger(target, decision, message, parsed.retry === true);
    const timestamp = new Date().toISOString();
    const updated = await this.repository.transaction(async (repository) => {
      const record = await repository.decisions.get(decisionId);
      if (!record || record.status !== "pending" || record.revision !== parsed.expectedRevision) {
        throw decisionError("STORY_DECISION_REVISION_CONFLICT", "The decision was modified by another request.", 409);
      }
      return repository.decisions.updateIfRevision(decisionId, parsed.expectedRevision, {
        status: "decided",
        revision: parsed.expectedRevision + 1,
        response: parsed.response,
        selectedOptionId: parsed.optionId,
        decidedTurnId: turnId,
        decidedAt: timestamp,
        updatedAt: timestamp,
        resumeState: null,
        resumeAttemptedAt: null,
      });
    });
    if (!updated) throw decisionError("STORY_DECISION_REVISION_CONFLICT", "The decision was modified by another request.", 409);
    const decisionResult = projectDecision(updated);
    this.emit("decided", decisionResult);
    return decisionResult;
  }

  /**
   * 旧实例退化路径（兼容 v0.0.33 及更早）：目标实例未声明发送幂等键时，先在自己的私有账本
   * 标记 `resuming`，确认创建 turn 后才写入 decidedTurnId。处于 `resuming` 的决策禁止盲目重发，
   * 必须由调用方通过 `retry` 显式确认。
   */
  private async dispatchWithResumingLedger(
    target: ControlledInstance,
    decision: StoryDecisionRecord,
    message: string,
    retry: boolean,
  ) {
    if (decision.resumeState === "resuming" && !retry) {
      throw Object.assign(
        decisionError(
          "STORY_DECISION_RESUME_PENDING",
          "A previous decision reply may already have reached the AI Session. Confirm an explicit retry to send it again.",
          409,
        ),
        {
          retryable: true,
          details: {
            targetTag: "v0.0.33",
            reason: "TARGET_INSTANCE_WITHOUT_SEND_IDEMPOTENCY",
            resumeAttemptedAt: decision.resumeAttemptedAt || undefined,
          },
        },
      );
    }
    const attemptedAt = new Date().toISOString();
    await this.repository.decisions.update(decision.id, { resumeState: "resuming", resumeAttemptedAt: attemptedAt });
    try {
      return await this.dispatchResponse(target, decision, message);
    } catch (error) {
      // 除传输层不确定外，收到明确拒绝说明消息未送达，可安全清除账本让调用方直接重试。
      if ((error as { code?: string }).code !== "STORY_DECISION_DISPATCH_UNAVAILABLE") {
        await this.repository.decisions.update(decision.id, { resumeState: null, resumeAttemptedAt: null });
      }
      throw error;
    }
  }

  async cancel(storyId: string, decisionId: string, input: StoryDecisionCancelInput) {
    const parsed = StoryDecisionCancelInputSchema.parse(input);
    await this.assertStoryMutable(storyId);
    const decision = await this.requireDecision(storyId, decisionId);
    if (decision.status !== "pending") {
      throw decisionError("STORY_DECISION_TERMINAL", "The decision is no longer pending.", 409);
    }
    const timestamp = new Date().toISOString();
    const updated = await this.repository.transaction(async (repository) => repository.decisions.updateIfRevision(decisionId, parsed.expectedRevision, {
      status: "cancelled",
      revision: parsed.expectedRevision + 1,
      updatedAt: timestamp,
    }));
    if (!updated) throw decisionError("STORY_DECISION_REVISION_CONFLICT", "The decision was modified by another request.", 409);
    const decisionResult = projectDecision(updated);
    this.emit("cancelled", decisionResult);
    return decisionResult;
  }

  /** 权威侧失效收敛：会话关闭或删除时把该会话的 pending 决策转为 expired。 */
  async expireForSession(sessionId: string, reason: StoryDecisionExpiredReason) {
    const timestamp = new Date().toISOString();
    const expired = await this.repository.decisions.expirePendingForSession(sessionId, reason, timestamp);
    const decisions = expired.map(projectDecision);
    for (const decision of decisions) this.emit("expired", decision);
    return decisions;
  }

  async expireForStory(storyId: string, reason: StoryDecisionExpiredReason) {
    const story = await this.repository.stories.get(storyId);
    if (!story) return [];
    const pending = (await this.repository.decisions.list(storyId)).filter((record) => record.status === "pending");
    const results: StoryDecision[] = [];
    for (const record of pending) {
      const updated = await this.repository.decisions.updateIfRevision(record.id, record.revision, {
        status: "expired",
        revision: record.revision + 1,
        expiredReason: reason,
        updatedAt: new Date().toISOString(),
      });
      if (updated) {
        const decision = projectDecision(updated);
        this.emit("expired", decision);
        results.push(decision);
      }
    }
    return results;
  }

  private async dispatchResponse(instance: ControlledInstance, decision: StoryDecision, message: string, clientRequestId?: string) {
    if (!instance.registrationToken) throw decisionError("STORY_DECISION_SESSION_UNAVAILABLE", "The AI Session instance is unavailable.", 503);
    let response: Response;
    try {
      response = await this.fetchImpl(`${await this.resolveInstanceWeb(instance)}/api/internal/node-agent/ai-sessions/${encodeURIComponent(decision.sessionId)}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${instance.registrationToken}` },
        body: JSON.stringify(clientRequestId ? { message, clientRequestId } : { message }),
      });
    } catch (cause) {
      throw decisionError("STORY_DECISION_DISPATCH_UNAVAILABLE", "The AI Session instance is temporarily unavailable.", 503, cause);
    }
    const payload = await response.json().catch(() => ({})) as { data?: unknown; error?: { code?: string; message?: string } };
    if (!response.ok) {
      throw decisionError(payload.error?.code || "STORY_DECISION_DISPATCH_FAILED", payload.error?.message || `AI Session send failed with HTTP ${response.status}.`, response.status);
    }
    return InternalSendResultSchema.parse(payload.data || {}).turnId;
  }

  private findSessionInstance(storyId: string, sessionId: string) {
    return this.state.listInstances().find((instance) => (
      Boolean(instance.registrationToken)
      && instance.aiSessions.sessions.some((session) => session.id === sessionId && session.storyId === storyId)
    ));
  }

  private async requireStory(storyId: string) {
    const story = await this.repository.stories.get(storyId);
    if (!story) throw decisionError("STORY_NOT_FOUND", "Story was not found.", 404);
    return story;
  }

  // 归档 Story 的决策保持只读：既不接受新登记，也不允许下达或取消。
  private async assertStoryMutable(storyId: string) {
    const story = await this.requireStory(storyId);
    if (story.archivedAt) throw decisionError("STORY_DECISION_STORY_ARCHIVED", "Archived Story decisions are read-only.", 409);
    return story;
  }

  private async requireDecision(storyId: string, decisionId: string) {
    const record = await this.repository.decisions.get(decisionId);
    if (!record || record.storyId !== storyId) throw decisionError("STORY_DECISION_NOT_FOUND", "Story decision was not found.", 404);
    return record;
  }

  private emit(change: StoryDecisionChangedEvent["change"], decision: StoryDecision) {
    this.publish?.({
      storyId: decision.storyId,
      decisionId: decision.id,
      revision: decision.revision,
      change,
      decision,
    });
  }
}

export function projectDecision(record: StoryDecisionRecord): StoryDecision {
  return StoryDecisionSchema.parse({
    id: record.id,
    storyId: record.storyId,
    sessionId: record.sessionId,
    turnId: record.turnId || undefined,
    question: record.question,
    options: record.options || [],
    allowFreeText: record.allowFreeText,
    context: record.context || undefined,
    status: record.status,
    revision: record.revision,
    response: record.response || undefined,
    selectedOptionId: record.selectedOptionId || undefined,
    decidedTurnId: record.decidedTurnId || undefined,
    expiredReason: record.expiredReason || undefined,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    decidedAt: record.decidedAt || undefined,
  });
}

function sameDecisionReply(record: StoryDecisionRecord, input: StoryDecisionDecideInput) {
  return (record.selectedOptionId || undefined) === (input.optionId || undefined)
    && (record.response || undefined) === (input.response || undefined);
}

function composeDecisionResponse(decision: StoryDecision, input: StoryDecisionDecideInput) {
  const parts: string[] = [];
  if (input.optionId) {
    const option = (decision.options || []).find((candidate) => candidate.id === input.optionId);
    parts.push(`Selected decision option: ${option?.label || input.optionId}`);
  }
  if (input.response) parts.push(input.response);
  return parts.join("\n\n");
}

function decisionError(code: string, message: string, statusCode: number, cause?: unknown) {
  return Object.assign(new Error(message), { code, statusCode, ...(cause === undefined ? {} : { cause }) });
}
