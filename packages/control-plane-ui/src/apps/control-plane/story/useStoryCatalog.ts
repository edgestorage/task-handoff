import { computed, type MaybeRefOrGetter } from "vue";
import { useQueries } from "@tanstack/vue-query";
import type { Story } from "@task-handoff/protocol/stories";
import { storyNodeQueryOptions, useNodesQuery } from "../../../api/queries";
import { storyNodeLoadState, type StoryNodeLoadState } from "./storyNodeLoad";

export type { StoryNodeLoadState };

/**
 * Reads the Story directory one node at a time. Node agents answer
 * independently, so the list grows as each node responds instead of waiting for
 * the slowest node in one aggregate request. The per-node queries keep the
 * control-plane Story query keys, so they share cache and invalidation with
 * every other node-scoped Story consumer.
 */
export function useStoryCatalog(enabled: MaybeRefOrGetter<boolean> = true) {
  const nodesQuery = useNodesQuery();
  const nodeIds = computed(() => (nodesQuery.data.value || []).map((node) => node.id));
  const nodeQueries = useQueries({
    queries: () => nodeIds.value.map((nodeId) => storyNodeQueryOptions(nodeId, enabled)),
  });

  function nodeQuery(nodeId: string) {
    const index = nodeIds.value.indexOf(nodeId);
    return index < 0 ? undefined : nodeQueries.value[index];
  }

  function nodeLoadState(nodeId: string): StoryNodeLoadState {
    return storyNodeLoadState(nodeId, nodeQuery(nodeId));
  }

  const stories = computed<Story[]>(() => nodeIds.value.flatMap((_, index) => nodeQueries.value[index]?.data?.stories || []));
  const loadingNodeIds = computed(() => nodeIds.value.filter((nodeId) => nodeLoadState(nodeId) === "loading"));
  const unavailableNodeIds = computed(() => nodeIds.value.filter((nodeId) => nodeLoadState(nodeId) === "unavailable"));
  const isPending = computed(() => nodesQuery.isPending.value || loadingNodeIds.value.length > 0);
  const isFetching = computed(() => nodesQuery.isFetching.value || nodeQueries.value.some((query) => query.isFetching));

  async function refetch(nodeId?: string) {
    const targets = nodeIds.value
      .filter((id) => !nodeId || id === nodeId)
      .map((id) => nodeQuery(id))
      .filter((query) => Boolean(query));
    if (!nodeId && !targets.length) await nodesQuery.refetch();
    return Promise.all(targets.map((query) => query?.refetch()));
  }

  return { stories, nodeIds, loadingNodeIds, unavailableNodeIds, nodeLoadState, isPending, isFetching, refetch };
}
