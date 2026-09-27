export type NodeVisibilityFilter =
  | { kind: "all" }
  | { kind: "selected"; nodeIds: string[] };

export function allNodesVisible(): NodeVisibilityFilter {
  return { kind: "all" };
}

export function nodeIsSelected(filter: NodeVisibilityFilter, nodeId: string): boolean {
  return filter.kind === "selected" && filter.nodeIds.includes(nodeId);
}

export function nodeIsVisible(filter: NodeVisibilityFilter, nodeId: string): boolean {
  return filter.kind === "all" || filter.nodeIds.includes(nodeId);
}

export function selectOnlyNode(nodeId: string): NodeVisibilityFilter {
  return { kind: "selected", nodeIds: [nodeId] };
}

export function toggleNodeVisibility(filter: NodeVisibilityFilter, nodeId: string, visible: boolean, availableNodeIds: string[]): NodeVisibilityFilter {
  const selected = new Set(filter.kind === "selected" ? filter.nodeIds : []);
  if (visible) selected.add(nodeId);
  else selected.delete(nodeId);
  return normalizeNodeVisibilityFilter({ kind: "selected", nodeIds: [...selected] }, availableNodeIds);
}

export function normalizeNodeVisibilityFilter(filter: NodeVisibilityFilter, availableNodeIds: string[]): NodeVisibilityFilter {
  if (filter.kind === "all") return filter;
  const available = [...new Set(availableNodeIds.map((nodeId) => nodeId.trim()).filter(Boolean))];
  const selected = new Set(filter.nodeIds.map((nodeId) => nodeId.trim()).filter(Boolean));
  const nodeIds = available.filter((nodeId) => selected.has(nodeId));
  return nodeIds.length === 0 || nodeIds.length === available.length ? allNodesVisible() : { kind: "selected", nodeIds };
}
