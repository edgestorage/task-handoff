export type StoryResourceDropPlacement = "before" | "after";
export type StoryResourceDropTarget = { key: string; placement: StoryResourceDropPlacement };

export function storyResourceDropTargetAt(targets: readonly { key: string; midpoint: number }[], clientX: number): StoryResourceDropTarget | undefined {
  const target = targets.find((candidate) => clientX < candidate.midpoint);
  if (target) return { key: target.key, placement: "before" };
  const last = targets.at(-1);
  return last ? { key: last.key, placement: "after" } : undefined;
}

export function reorderStoryResourceKeys(order: string[], sourceKey: string, targetKey: string, placement: StoryResourceDropPlacement) {
  const sourceIndex = order.indexOf(sourceKey);
  const targetIndex = order.indexOf(targetKey);
  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return order;
  const next = [...order];
  next.splice(sourceIndex, 1);
  const insertionIndex = next.indexOf(targetKey) + (placement === "after" ? 1 : 0);
  next.splice(insertionIndex, 0, sourceKey);
  return next.some((key, index) => key !== order[index]) ? next : order;
}
