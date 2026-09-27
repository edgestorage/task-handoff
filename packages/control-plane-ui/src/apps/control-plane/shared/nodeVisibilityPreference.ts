import { allNodesVisible, type NodeVisibilityFilter } from "@task-handoff/control-plane-client";

type StorageLike = Pick<Storage, "getItem" | "setItem">;

const STORAGE_KEY = "task-handoff.control-plane.node-visibility";
// Compatibility: 旧版本只给 Story 视图保存过节点选择，键名带 story；新键缺失时回退读取旧键，
// 之后只写新键，避免两个视图各存一份节点作用域。
const LEGACY_STORY_STORAGE_KEY = "task-handoff.control-plane.story-node-filter";

function browserStorage(): StorageLike | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

// Selected node ids are kept as read; unavailable nodes are dropped once the node directory is known.
export function parseNodeVisibilityFilter(value: string | null | undefined): NodeVisibilityFilter {
  if (!value) return allNodesVisible();
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return allNodesVisible();
    const record = parsed as Record<string, unknown>;
    if (record.kind === "all") return allNodesVisible();
    if (record.kind !== "selected" || !Array.isArray(record.nodeIds)) return allNodesVisible();
    const nodeIds = [...new Set(record.nodeIds
      .filter((nodeId): nodeId is string => typeof nodeId === "string")
      .map((nodeId) => nodeId.trim())
      .filter(Boolean))];
    return nodeIds.length > 0 ? { kind: "selected", nodeIds } : allNodesVisible();
  } catch {
    return allNodesVisible();
  }
}

export function loadNodeVisibilityFilter(storage = browserStorage()): NodeVisibilityFilter {
  if (!storage) return allNodesVisible();
  try {
    const stored = storage.getItem(STORAGE_KEY);
    return parseNodeVisibilityFilter(stored === null ? storage.getItem(LEGACY_STORY_STORAGE_KEY) : stored);
  } catch {
    return allNodesVisible();
  }
}

export function persistNodeVisibilityFilter(filter: NodeVisibilityFilter, storage = browserStorage()) {
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(filter.kind === "all" ? { kind: "all" } : { kind: "selected", nodeIds: filter.nodeIds }));
  } catch {
    // Storage can be disabled or full; the current filter still applies.
  }
}
