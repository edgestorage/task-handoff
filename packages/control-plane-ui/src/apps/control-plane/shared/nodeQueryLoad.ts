export type NodeLoadState = "loading" | "ready" | "unavailable" | "paused";

export type NodeQuerySnapshot = {
  data?: { unavailableNodeIds: readonly string[] };
  isError: boolean;
} | undefined;

/**
 * Node Agent 各自独立应答，因此「可用」由该 Node 自己的响应声明：
 * 请求失败或聚合结果把它列入 unavailableNodeIds 都算不可用，其余才是 ready。
 */
export function nodeQueryLoadState(nodeId: string, query: NodeQuerySnapshot, connectionEnabled = true): NodeLoadState {
  // The authoritative connection switch takes precedence over cached responses
  // and errors. Pausing a node is an intentional state, not a failed read.
  if (!connectionEnabled) return "paused";
  if (!query) return "loading";
  if (query.isError) return "unavailable";
  if (!query.data) return "loading";
  return query.data.unavailableNodeIds.includes(nodeId) ? "unavailable" : "ready";
}
