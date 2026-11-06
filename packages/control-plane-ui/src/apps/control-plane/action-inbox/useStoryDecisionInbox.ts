import { computed, type MaybeRefOrGetter } from "vue";
import { useQueries } from "@tanstack/vue-query";
import { storyDecisionsQueryOptions, storyNodeQueryOptions, useNodesQuery } from "../../../api/queries";
import { storyDecisionInboxItems, storyDecisionNodes } from "./storyDecisionItems";

/**
 * Story 决策入箱：只对声明 decisions 能力的节点读取 Story 目录，再按 Story 拉取决策。
 * 查询键与 Story 视图共用，Story 事件失效、节点恢复和重连恢复统一由事件消费边界处理。
 */
export function useStoryDecisionInbox(enabled: MaybeRefOrGetter<boolean> = true) {
  const nodesQuery = useNodesQuery(enabled);
  const decisionNodes = computed(() => storyDecisionNodes(nodesQuery.data.value || []));
  const storyQueries = useQueries({
    queries: () => decisionNodes.value.map((node) => storyNodeQueryOptions(node.id, enabled)),
  });
  const decisionStories = computed(() => decisionNodes.value.flatMap((_, index) => storyQueries.value[index]?.data?.stories || []));
  const decisionQueries = useQueries({
    queries: () => decisionStories.value.map((story) => storyDecisionsQueryOptions(story.id, story.ownerNodeId, enabled)),
  });
  const items = computed(() => storyDecisionInboxItems(decisionStories.value.map((story, index) => ({
    story,
    decisions: decisionQueries.value[index]?.data?.decisions || [],
  }))));

  return { items };
}
