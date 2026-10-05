import { computed, type MaybeRefOrGetter, watch } from "vue";
import { useQueries } from "@tanstack/vue-query";
import { storyDecisionsQueryOptions, storyNodeQueryOptions, useNodesQuery } from "../../../api/queries";
import { storyDecisionInboxItems, storyDecisionNodes } from "./storyDecisionItems";

/**
 * Story 决策入箱：只对声明 decisions 能力的节点读取 Story 目录，再按 Story 拉取决策。
 * 查询键与 Story 视图共用，Story 事件失效和重连恢复对审批中心同样生效。
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

  // 目录与决策都是快照式查询：节点恢复在线后补拉一次曾经不可用的快照，否则审批中心会一直缺项。
  const reachabilitySignature = computed(() => (nodesQuery.data.value || [])
    .map((node) => `${node.id}:${node.status}:${node.connectionPhase || ""}`)
    .join("|"));
  watch(reachabilitySignature, () => {
    decisionNodes.value.forEach((node, index) => {
      const query = storyQueries.value[index];
      const unavailable = Boolean(query?.isError) || Boolean(query?.data?.unavailableNodeIds.includes(node.id));
      if (unavailable && node.status !== "offline" && node.status !== "unknown") void query?.refetch();
    });
    for (const query of decisionQueries.value) if (query.isError) void query.refetch();
  });

  return { items };
}
