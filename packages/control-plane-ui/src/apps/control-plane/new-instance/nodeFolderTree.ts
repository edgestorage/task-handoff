import type { NodeFolderTreeEntry } from "../../../api/types";

export type NodeFolderTreeNode = NodeFolderTreeEntry & {
  depth: number;
  expanded: boolean;
  loaded: boolean;
  loading: boolean;
  children: NodeFolderTreeNode[];
};

export function folderTreeNode(entry: NodeFolderTreeEntry, depth: number): NodeFolderTreeNode {
  return {
    ...entry,
    depth,
    expanded: false,
    loaded: false,
    loading: false,
    children: [],
  };
}

export function flattenFolderTree(entries: NodeFolderTreeNode[]): NodeFolderTreeNode[] {
  return entries.flatMap((entry) => [
    entry,
    ...(entry.expanded ? flattenFolderTree(entry.children) : []),
  ]);
}
