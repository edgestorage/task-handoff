import { computed, toValue, type MaybeRefOrGetter } from "vue";
import { useQueries } from "@tanstack/vue-query";
import { controlPlaneAgentCapabilities } from "@task-handoff/control-plane-client";
import { agentNodeQueryOptions, agentOrchestrationsQueryOptions, nodeLocalFoldersQueryOptions, storyAgentEntriesQueryOptions, useAgentRunsQuery, useInstanceBoardQuery, useNodesQuery } from "../../../api/queries";
import { nodeQueryLoadState, type NodeLoadState } from "../shared/nodeQueryLoad.ts";
import { buildAgentCatalog, type AgentCatalogDefinition, type AgentCatalogInput, type AgentCatalogStoryEntries } from "./agentCatalog";
import type { NodeLocalFolder } from "../../../api/types";
import { useStoryCatalog } from "../story/useStoryCatalog.ts";

/**
 * Agent 目录按 Node 独立读取：每个 Node Agent 只回答自己的定义，列表随各 Node 响应逐步出现，
 * 不等待最慢的 Node。文件夹路径与运行能力同样来自该 Node 的权威数据，界面不做本地推断。
 * 未发布的 Node 与未启用的视图都不发请求，因此关闭入口不会新增任何请求路径。
 */
export function useAgentCatalog(options: {
  providerLabel?: AgentCatalogInput["providerLabel"];
  enabled?: MaybeRefOrGetter<boolean>;
} = {}) {
  const nodesQuery = useNodesQuery();
  const nodes = computed(() => nodesQuery.data.value || []);
  const capableNodeIds = computed(() => nodes.value
    .filter((node) => controlPlaneAgentCapabilities(node.capabilities).definitions)
    .map((node) => node.id));
  const activeNodeIds = computed(() => (toValue(options.enabled ?? true) ? capableNodeIds.value : []));
  const runsEnabled = computed(() => toValue(options.enabled ?? true) && nodes.value.some((node) => controlPlaneAgentCapabilities(node.capabilities).runs));
  const agentQueries = useQueries({ queries: () => activeNodeIds.value.map((nodeId) => agentNodeQueryOptions(nodeId)) });
  // 编排与定义同属 Agent 域：Run 必须绑定编排，因此编排读取失败只影响运行入口，不影响定义维护。
  const orchestrationQueries = useQueries({
    queries: () => activeNodeIds.value.map((nodeId) => agentOrchestrationsQueryOptions(
      nodeId,
      controlPlaneAgentCapabilities(nodes.value.find((node) => node.id === nodeId)?.capabilities).orchestrations,
    )),
  });
  const folderQueries = useQueries({ queries: () => activeNodeIds.value.map((nodeId) => nodeLocalFoldersQueryOptions(nodeId)) });
  const board = useInstanceBoardQuery();
  const runsQuery = useAgentRunsQuery(runsEnabled);
  const stories = useStoryCatalog(options.enabled ?? true);
  const entryStories = computed(() => stories.stories.value.filter((story) => {
    const node = nodes.value.find((candidate) => candidate.id === story.ownerNodeId);
    return activeNodeIds.value.includes(story.ownerNodeId)
      && controlPlaneAgentCapabilities(node?.capabilities).storyEntryAuthorization;
  }));
  const storyEntryQueries = useQueries({
    queries: () => entryStories.value.map((story) => storyAgentEntriesQueryOptions(story.id, story.ownerNodeId)),
  });

  function nodeLoadState(nodeId: string): NodeLoadState {
    const index = activeNodeIds.value.indexOf(nodeId);
    return nodeQueryLoadState(nodeId, index < 0 ? undefined : agentQueries.value[index]);
  }

  const definitions = computed<AgentCatalogDefinition[]>(() => activeNodeIds.value.flatMap((nodeId, index) => (
    (agentQueries.value[index]?.data?.agents || []).map((entry) => ({ nodeId, agent: entry.agent }))
  )));
  const orchestrations = computed(() => activeNodeIds.value.flatMap((nodeId, index) => (
    (orchestrationQueries.value[index]?.data?.orchestrations || []).map((entry) => ({ nodeId, orchestration: entry.orchestration }))
  )));
  const foldersByNode = computed(() => new Map<string, NodeLocalFolder[]>(activeNodeIds.value.map((nodeId, index) => [
    nodeId,
    (folderQueries.value[index]?.data || []) as NodeLocalFolder[],
  ])));
  const storyEntries = computed<AgentCatalogStoryEntries[]>(() => entryStories.value.flatMap((story, index) => {
    const entrySet = storyEntryQueries.value[index]?.data;
    return entrySet ? [{ nodeId: story.ownerNodeId, storyLabel: story.title, entrySet }] : [];
  }));

  const catalog = computed(() => buildAgentCatalog({
    nodes: nodes.value,
    definitions: definitions.value,
    orchestrations: orchestrations.value,
    runs: runsQuery.data.value?.runs ?? [],
    storyEntries: storyEntries.value,
    instances: board.data.value || [],
    foldersByNode: foldersByNode.value,
    providerLabel: options.providerLabel,
  }));

  const loadingNodeIds = computed(() => activeNodeIds.value.filter((nodeId) => nodeLoadState(nodeId) === "loading"));
  const unavailableNodeIds = computed(() => [...new Set([
    ...activeNodeIds.value.filter((nodeId) => nodeLoadState(nodeId) === "unavailable"),
    ...(runsQuery.data.value?.unavailableNodeIds ?? []),
  ])]);
  // 列表的 pending 只由目录自身的读取决定，与 Story 目录同语义：Run、编排等其它域的
  // 读取不阻塞 Agent 列表进入就绪态，它们各自在消费位置表达加载状态。
  const isPending = computed(() => nodesQuery.isPending.value || loadingNodeIds.value.length > 0);
  const isFetching = computed(() => nodesQuery.isFetching.value || runsQuery.isFetching.value
    || agentQueries.value.some((query) => query.isFetching)
    || orchestrationQueries.value.some((query) => query.isFetching));

  async function refetch() {
    await Promise.all([
      nodesQuery.refetch(),
      ...agentQueries.value.map((query) => query.refetch()),
      ...orchestrationQueries.value.map((query) => query.refetch()),
      ...folderQueries.value.map((query) => query.refetch()),
      ...storyEntryQueries.value.map((query) => query.refetch()),
      ...(runsEnabled.value ? [runsQuery.refetch()] : []),
    ]);
  }

  return { catalog, nodes, capableNodeIds, loadingNodeIds, unavailableNodeIds, nodeLoadState, isPending, isFetching, refetch };
}
