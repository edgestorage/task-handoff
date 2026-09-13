import type { Story } from "@task-handoff/protocol/stories";
import { normalizeManualStoryOrder, reorderStoryKeys, storyOrderKey } from "@task-handoff/control-plane-client";

export { normalizeManualStoryOrder, reorderStoryKeys } from "@task-handoff/control-plane-client";

export type StorySortMode = "name" | "last-user-message" | "manual";

export function storySortKey(story: Pick<Story, "id" | "ownerNodeId">) {
  return storyOrderKey(story);
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
  const byArchiveState = (left: Story, right: Story) => Number(Boolean(left.archivedAt)) - Number(Boolean(right.archivedAt));
  const byName = (left: Story, right: Story) => (
    collator.compare(left.title, right.title) || storySortKey(left).localeCompare(storySortKey(right))
  );
  if (mode === "name") return [...stories].sort((left, right) => byArchiveState(left, right) || byName(left, right));
  if (mode === "last-user-message") {
    return [...stories].sort((left, right) => (
      byArchiveState(left, right)
      || (options.lastUserMessageTimes.get(storySortKey(right)) || 0)
      - (options.lastUserMessageTimes.get(storySortKey(left)) || 0)
      || byName(left, right)
    ));
  }
  const order = new Map(normalizeManualStoryOrder(stories, options.manualKeys).map((key, index) => [key, index]));
  return [...stories].sort((left, right) => (
    byArchiveState(left, right)
    || (order.get(storySortKey(left)) ?? Number.MAX_SAFE_INTEGER)
    - (order.get(storySortKey(right)) ?? Number.MAX_SAFE_INTEGER)
    || byName(left, right)
  ));
}

export type StoryDropRow = { key: string; top: number; height: number };

export function storyDropTargetAt(rows: readonly StoryDropRow[], sourceKey: string, clientY: number) {
  const candidates = rows.filter((row) => row.key !== sourceKey);
  const target = candidates.find((row) => clientY < row.top + row.height / 2);
  if (target) return { targetKey: target.key, placement: "before" as const };
  const last = candidates.at(-1);
  return last ? { targetKey: last.key, placement: "after" as const } : undefined;
}
