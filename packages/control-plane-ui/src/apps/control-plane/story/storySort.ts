import type { Story } from "@task-handoff/protocol/stories";

export type StorySortMode = "name" | "last-user-message" | "manual";

export function storySortKey(story: Pick<Story, "id" | "ownerNodeId">) {
  return `${story.ownerNodeId}:${story.id}`;
}

export function normalizeManualStoryOrder(stories: readonly Story[], keys: readonly string[]) {
  const available = new Set(stories.map(storySortKey));
  const known = new Set<string>();
  const normalized: string[] = [];
  for (const key of keys) {
    if (!available.has(key) || known.has(key)) continue;
    normalized.push(key);
    known.add(key);
  }
  for (const story of stories) {
    const key = storySortKey(story);
    if (!known.has(key)) {
      normalized.push(key);
      known.add(key);
    }
  }
  return normalized;
}

export function sortStories(
  stories: readonly Story[],
  mode: StorySortMode,
  options: {
    locale: string;
    lastUserMessageTimes: ReadonlyMap<string, number>;
    manualKeys: readonly string[];
  },
) {
  const collator = new Intl.Collator(options.locale, { numeric: true, sensitivity: "base" });
  const byName = (left: Story, right: Story) => (
    collator.compare(left.title, right.title) || storySortKey(left).localeCompare(storySortKey(right))
  );
  if (mode === "name") return [...stories].sort(byName);
  if (mode === "last-user-message") {
    return [...stories].sort((left, right) => (
      (options.lastUserMessageTimes.get(storySortKey(right)) || 0)
      - (options.lastUserMessageTimes.get(storySortKey(left)) || 0)
      || byName(left, right)
    ));
  }
  const order = new Map(normalizeManualStoryOrder(stories, options.manualKeys).map((key, index) => [key, index]));
  return [...stories].sort((left, right) => (
    (order.get(storySortKey(left)) ?? Number.MAX_SAFE_INTEGER)
    - (order.get(storySortKey(right)) ?? Number.MAX_SAFE_INTEGER)
    || byName(left, right)
  ));
}

export function reorderStoryKeys(keys: readonly string[], sourceKey: string, targetKey: string, placement: "before" | "after") {
  if (sourceKey === targetKey || !keys.includes(sourceKey) || !keys.includes(targetKey)) return [...keys];
  const next = keys.filter((key) => key !== sourceKey);
  const targetIndex = next.indexOf(targetKey);
  next.splice(targetIndex + (placement === "after" ? 1 : 0), 0, sourceKey);
  return next;
}

export type StoryDropRow = { key: string; top: number; height: number };

export function storyDropTargetAt(rows: readonly StoryDropRow[], sourceKey: string, clientY: number) {
  const candidates = rows.filter((row) => row.key !== sourceKey);
  const target = candidates.find((row) => clientY < row.top + row.height / 2);
  if (target) return { targetKey: target.key, placement: "before" as const };
  const last = candidates.at(-1);
  return last ? { targetKey: last.key, placement: "after" as const } : undefined;
}
