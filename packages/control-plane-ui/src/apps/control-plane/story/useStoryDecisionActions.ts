import { ref, toValue, type MaybeRefOrGetter } from "vue";
import { useQueryClient } from "@tanstack/vue-query";
import type { StoryDecision } from "@task-handoff/protocol/stories";
import { controlPlaneQueryKeys } from "../../../api/queryKeys.ts";
import { cancelStoryDecision, decideStoryDecision } from "../../../api/queries.ts";
import { applyStoryDecisionUpdate, isStoryDecisionResumePending, type StoryDecisionList } from "../action-inbox/storyDecisionItems.ts";
import type { StoryDecisionAnswerInput } from "./storyDecisionPresentation.ts";

/**
 * 决策答复只有一套提交/重试状态机：Story 决策面板与会话内提示共用，
 * 提交后统一把权威响应写回共享决策快照，避免各入口各自维护状态。
 */
export function useStoryDecisionActions(storyId: MaybeRefOrGetter<string>, nodeId: MaybeRefOrGetter<string>) {
  const queryClient = useQueryClient();
  const busyId = ref("");
  const actionError = ref<{ decisionId: string; message: string } | null>(null);
  const resumePendingId = ref("");
  const resumeInput = ref<{ decisionId: string; input: StoryDecisionAnswerInput } | null>(null);

  type DecisionTarget = { storyId: string; nodeId: string };

  // 请求发出时锁定目标 Story：切换 Story 后返回的旧响应必须写回它自己的快照。
  function currentTarget(): DecisionTarget {
    return { storyId: toValue(storyId), nodeId: toValue(nodeId) };
  }

  function applyUpdatedDecision(target: DecisionTarget, updated: StoryDecision) {
    const key = controlPlaneQueryKeys.storyDecisions(target.nodeId, target.storyId);
    queryClient.setQueryData(key, (current: StoryDecisionList | undefined) => applyStoryDecisionUpdate(current, updated));
  }

  async function submit(decision: StoryDecision, input: StoryDecisionAnswerInput, retry = false) {
    const target = currentTarget();
    busyId.value = decision.id;
    actionError.value = null;
    try {
      const updated = await decideStoryDecision(target.storyId, decision.id, target.nodeId, {
        expectedRevision: decision.revision,
        ...input,
        ...(retry ? { retry: true } : {}),
      });
      resumePendingId.value = "";
      resumeInput.value = null;
      applyUpdatedDecision(target, updated);
    } catch (cause) {
      actionError.value = { decisionId: decision.id, message: cause instanceof Error ? cause.message : String(cause) };
      const resumePending = isStoryDecisionResumePending(cause);
      resumePendingId.value = resumePending ? decision.id : "";
      resumeInput.value = resumePending ? { decisionId: decision.id, input } : null;
    } finally {
      busyId.value = "";
    }
  }

  function retry(decision: StoryDecision) {
    const pending = resumeInput.value;
    if (pending?.decisionId === decision.id) void submit(decision, pending.input, true);
  }

  async function cancel(decision: StoryDecision) {
    const target = currentTarget();
    busyId.value = decision.id;
    actionError.value = null;
    try {
      applyUpdatedDecision(target, await cancelStoryDecision(target.storyId, decision.id, target.nodeId, { expectedRevision: decision.revision }));
    } catch (cause) {
      actionError.value = { decisionId: decision.id, message: cause instanceof Error ? cause.message : String(cause) };
    } finally {
      busyId.value = "";
    }
  }

  function reset() {
    actionError.value = null;
    resumePendingId.value = "";
    resumeInput.value = null;
  }

  return { actionError, busyId, resumePendingId, submit, retry, cancel, reset };
}
