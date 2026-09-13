export type StoryNodeFilter =
  | { kind: "all" }
  | { kind: "selected"; nodeIds: string[] };

export function allStoryNodes(): StoryNodeFilter {
  return { kind: "all" };
}

export function storyNodeIsSelected(filter: StoryNodeFilter, nodeId: string): boolean {
  return filter.kind === "selected" && filter.nodeIds.includes(nodeId);
}

export function storyNodeIsVisible(filter: StoryNodeFilter, nodeId: string): boolean {
  return filter.kind === "all" || filter.nodeIds.includes(nodeId);
}

export function selectOnlyStoryNode(nodeId: string): StoryNodeFilter {
  return { kind: "selected", nodeIds: [nodeId] };
}

export function toggleStoryNode(filter: StoryNodeFilter, nodeId: string, checked: boolean, availableNodeIds: string[]): StoryNodeFilter {
  const selected = new Set(filter.kind === "selected" ? filter.nodeIds : []);
  if (checked) selected.add(nodeId);
  else selected.delete(nodeId);
  return normalizeStoryNodeFilter({ kind: "selected", nodeIds: [...selected] }, availableNodeIds);
}

export function normalizeStoryNodeFilter(filter: StoryNodeFilter, availableNodeIds: string[]): StoryNodeFilter {
  if (filter.kind === "all") return filter;
  const available = [...new Set(availableNodeIds.map((nodeId) => nodeId.trim()).filter(Boolean))];
  const selected = new Set(filter.nodeIds.map((nodeId) => nodeId.trim()).filter(Boolean));
  const nodeIds = available.filter((nodeId) => selected.has(nodeId));
  return nodeIds.length === 0 || nodeIds.length === available.length ? allStoryNodes() : { kind: "selected", nodeIds };
}
