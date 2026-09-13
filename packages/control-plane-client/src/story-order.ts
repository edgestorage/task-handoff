import type { Story } from "@task-handoff/protocol/stories";

export function storyOrderKey(story: Pick<Story, "id" | "ownerNodeId">) {
  return `${story.ownerNodeId}:${story.id}`;
}

export function normalizeManualStoryOrder(stories: readonly Story[], keys: readonly string[]) {
  const available = new Set(stories.map(storyOrderKey));
  const known = new Set<string>();
  const normalized: string[] = [];
  for (const key of keys) {
    if (!available.has(key) || known.has(key)) continue;
    normalized.push(key);
    known.add(key);
  }
  for (const story of stories) {
    const key = storyOrderKey(story);
    if (!known.has(key)) {
      normalized.push(key);
      known.add(key);
    }
  }
  return normalized;
}

export function reorderStoryKeys(keys: readonly string[], sourceKey: string, targetKey: string, placement: "before" | "after") {
  if (sourceKey === targetKey || !keys.includes(sourceKey) || !keys.includes(targetKey)) return [...keys];
  const reordered = keys.filter((key) => key !== sourceKey);
  const targetIndex = reordered.indexOf(targetKey);
  reordered.splice(targetIndex + (placement === "after" ? 1 : 0), 0, sourceKey);
  return reordered;
}
