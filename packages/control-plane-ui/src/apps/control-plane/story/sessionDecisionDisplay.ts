import { onBeforeUnmount, readonly, ref, toValue, watch, type MaybeRefOrGetter } from "vue";

/**
 * “哪些决策正在会话里直接展示”由会话内提示独占登记：提示挂载时登记它渲染的待决策，
 * 决策离开列表或提示卸载时注销。右上角审批中心消费同一份登记，把已经在会话里可见的决策
 * 从浮层移除，其他会话的决策保持可见。
 * 用计数登记而不是集合，多个会话视图同时展示同一决策时，先卸载的那个不会提前恢复浮层展示。
 */
const displayCounts = new Map<string, number>();
const displayedDecisionIds = ref<ReadonlySet<string>>(new Set());

function publishDisplayedDecisionIds() {
  displayedDecisionIds.value = new Set(displayCounts.keys());
}

export function inSessionDisplayedDecisionIds() {
  return readonly(displayedDecisionIds);
}

export function retainInSessionDisplayedDecisions(decisionIds: Iterable<string>) {
  let changed = false;
  for (const id of decisionIds) {
    displayCounts.set(id, (displayCounts.get(id) || 0) + 1);
    changed = true;
  }
  if (changed) publishDisplayedDecisionIds();
}

export function releaseInSessionDisplayedDecisions(decisionIds: Iterable<string>) {
  let changed = false;
  for (const id of decisionIds) {
    const count = displayCounts.get(id) || 0;
    if (count <= 0) continue;
    if (count === 1) displayCounts.delete(id);
    else displayCounts.set(id, count - 1);
    changed = true;
  }
  if (changed) publishDisplayedDecisionIds();
}

export function useInSessionDecisionDisplay(decisionIds: MaybeRefOrGetter<readonly string[]>) {
  let registered = new Set<string>();
  watch(() => toValue(decisionIds), (next) => {
    const nextIds = new Set(next);
    releaseInSessionDisplayedDecisions([...registered].filter((id) => !nextIds.has(id)));
    retainInSessionDisplayedDecisions([...nextIds].filter((id) => !registered.has(id)));
    registered = nextIds;
  }, { immediate: true });
  onBeforeUnmount(() => {
    releaseInSessionDisplayedDecisions(registered);
    registered = new Set();
  });
}
