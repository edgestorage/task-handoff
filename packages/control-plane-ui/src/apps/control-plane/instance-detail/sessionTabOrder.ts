export function reorderSessionTabKeys(
  order: string[],
  sourceKey: string,
  targetKey: string,
  placement: "before" | "after",
  targetPaneKeys: string[] = [],
) {
  const nextOrder = order.filter((key) => key !== sourceKey);
  if (nextOrder.length === order.length) return order;

  if (targetKey) {
    const targetIndex = nextOrder.indexOf(targetKey);
    if (targetIndex < 0) return order;
    nextOrder.splice(placement === "after" ? targetIndex + 1 : targetIndex, 0, sourceKey);
    return nextOrder;
  }

  const lastTargetKey = [...targetPaneKeys].reverse().find((key) => key !== sourceKey && nextOrder.includes(key));
  const insertionIndex = lastTargetKey ? nextOrder.indexOf(lastTargetKey) + 1 : nextOrder.length;
  nextOrder.splice(insertionIndex, 0, sourceKey);
  return nextOrder;
}
