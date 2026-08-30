export type AiSessionPathGroupCollapseMode = "current" | "history";

type StorageLike = Pick<Storage, "getItem" | "removeItem" | "setItem">;

const STORAGE_PREFIX = "task-handoff.control-plane.ai-session-collapsed-path-groups";
const MAX_COLLAPSED_GROUPS = 500;

function storageKey(instanceId: string, mode: AiSessionPathGroupCollapseMode) {
  return `${STORAGE_PREFIX}.${encodeURIComponent(instanceId)}.${mode}`;
}

function browserStorage(): StorageLike | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

export function loadCollapsedAiSessionPathGroups(
  instanceId: string,
  mode: AiSessionPathGroupCollapseMode,
  storage = browserStorage(),
) {
  if (!storage || !instanceId) return {} as Record<string, boolean>;
  try {
    const parsed: unknown = JSON.parse(storage.getItem(storageKey(instanceId, mode)) || "[]");
    if (!Array.isArray(parsed)) return {};
    return Object.fromEntries(
      parsed
        .filter((key): key is string => typeof key === "string" && key.length > 0)
        .slice(-MAX_COLLAPSED_GROUPS)
        .map((key) => [key, true]),
    );
  } catch {
    return {};
  }
}

export function persistCollapsedAiSessionPathGroups(
  instanceId: string,
  mode: AiSessionPathGroupCollapseMode,
  groups: Readonly<Record<string, boolean>>,
  storage = browserStorage(),
) {
  if (!storage || !instanceId) return;
  const collapsed = Object.keys(groups).filter((key) => groups[key]).slice(-MAX_COLLAPSED_GROUPS);
  try {
    if (collapsed.length) storage.setItem(storageKey(instanceId, mode), JSON.stringify(collapsed));
    else storage.removeItem(storageKey(instanceId, mode));
  } catch {
    // Storage can be disabled or full; the in-memory preference still works.
  }
}
