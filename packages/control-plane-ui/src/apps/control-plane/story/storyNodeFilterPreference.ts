import { allStoryNodes, type StoryNodeFilter } from "@task-handoff/control-plane-client";

type StorageLike = Pick<Storage, "getItem" | "setItem">;

const STORAGE_KEY = "task-handoff.control-plane.story-node-filter";

function browserStorage(): StorageLike | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

// Selected node ids are kept as read; unavailable nodes are dropped once the node directory is known.
export function parseStoryNodeFilter(value: string | null | undefined): StoryNodeFilter {
  if (!value) return allStoryNodes();
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return allStoryNodes();
    const record = parsed as Record<string, unknown>;
    if (record.kind === "all") return allStoryNodes();
    if (record.kind !== "selected" || !Array.isArray(record.nodeIds)) return allStoryNodes();
    const nodeIds = [...new Set(record.nodeIds
      .filter((nodeId): nodeId is string => typeof nodeId === "string")
      .map((nodeId) => nodeId.trim())
      .filter(Boolean))];
    return nodeIds.length > 0 ? { kind: "selected", nodeIds } : allStoryNodes();
  } catch {
    return allStoryNodes();
  }
}

export function loadStoryNodeFilter(storage = browserStorage()): StoryNodeFilter {
  if (!storage) return allStoryNodes();
  try {
    return parseStoryNodeFilter(storage.getItem(STORAGE_KEY));
  } catch {
    return allStoryNodes();
  }
}

export function persistStoryNodeFilter(filter: StoryNodeFilter, storage = browserStorage()) {
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(filter.kind === "all" ? { kind: "all" } : { kind: "selected", nodeIds: filter.nodeIds }));
  } catch {
    // Storage can be disabled or full; the current filter still applies.
  }
}
