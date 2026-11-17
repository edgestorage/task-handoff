import { computed, ref, toValue, type MaybeRefOrGetter } from "vue";
import type { InstanceBoardItem, Node } from "../../../api/types";

export function useInstanceSettingsDirectory(instances: MaybeRefOrGetter<InstanceBoardItem[]>, nodes: MaybeRefOrGetter<Node[]>) {
  const search = ref("");
  const nodeId = ref("all");
  const status = ref("all");
  const runtimeType = ref("all");
  const nodeNames = computed(() => new Map(toValue(nodes).map((node) => [node.id, node.name])));
  const nodeName = (instance: InstanceBoardItem) => nodeNames.value.get(instance.nodeId) || instance.node?.name || instance.nodeId;
  const nodeOptions = computed(() => {
    const options = new Map<string, string>();
    for (const instance of toValue(instances)) options.set(instance.nodeId, nodeName(instance));
    return [...options].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  });
  const statusOptions = computed(() => [...new Set(toValue(instances).map((instance) => instance.status))].sort());
  const runtimeOptions = computed(() => [...new Set(toValue(instances).flatMap((instance) => instance.runtime ? [instance.runtime.type] : []))].sort());
  const hasActiveFilters = computed(() => Boolean(search.value.trim()) || nodeId.value !== "all" || status.value !== "all" || runtimeType.value !== "all");
  const filteredInstances = computed(() => {
    const term = search.value.trim().toLowerCase();
    return toValue(instances).filter((instance) => {
      if (nodeId.value !== "all" && instance.nodeId !== nodeId.value) return false;
      if (status.value !== "all" && instance.status !== status.value) return false;
      if (runtimeType.value !== "all" && instance.runtime?.type !== runtimeType.value) return false;
      if (!term) return true;
      const fields = [
        instance.name, instance.id, nodeName(instance), instance.nodeId,
        instance.project?.name, instance.projectId, instance.image?.name,
        instance.imageSnapshot?.name, instance.imageSelection?.imageId,
        instance.runtime?.name, instance.workspace.path,
      ];
      return fields.some((field) => field?.toLowerCase().includes(term));
    });
  });

  function clearFilters() {
    search.value = "";
    nodeId.value = "all";
    status.value = "all";
    runtimeType.value = "all";
  }

  return { search, nodeId, status, runtimeType, nodeName, nodeOptions, statusOptions, runtimeOptions, hasActiveFilters, filteredInstances, clearFilters };
}
