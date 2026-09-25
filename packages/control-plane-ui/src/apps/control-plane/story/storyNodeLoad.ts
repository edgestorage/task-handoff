export type StoryNodeLoadState = "loading" | "ready" | "unavailable";

export type StoryNodeQuerySnapshot = {
  data?: { unavailableNodeIds: readonly string[] };
  isError: boolean;
} | undefined;

/** A node is unavailable when its Story read failed or the node agent could not serve it. */
export function storyNodeLoadState(nodeId: string, query: StoryNodeQuerySnapshot): StoryNodeLoadState {
  if (!query) return "loading";
  if (query.isError) return "unavailable";
  if (!query.data) return "loading";
  return query.data.unavailableNodeIds.includes(nodeId) ? "unavailable" : "ready";
}
