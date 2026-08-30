import { computed, ref, watch, type Ref } from "vue";
import type { InstanceBoardItem } from "../../../api/types.ts";
import { instanceDisplayName as formatInstanceDisplayName } from "../useInstanceStatus.ts";

type UseWorkbenchInstancesInput<T extends InstanceBoardItem> = {
  instances: Ref<T[] | undefined>;
  selection?:
    | { mode: "persistent"; directoryComplete?: Ref<boolean> }
    | { mode: "standalone"; activeInstanceId: Ref<string> };
};

export type InstanceListSortMode = "name-asc" | "node-asc" | "status-asc";

const GROUP_BY_NODE_STORAGE_KEY = "task-handoff.control-plane.instances-group-by-node";
export const ACTIVE_INSTANCE_STORAGE_KEY = "task-handoff.control-plane.active-instance-id";

function nodeLabel(instance: InstanceBoardItem) {
  return instance.node?.name || instance.nodeId;
}

function storedGroupByNode() {
  return window.localStorage?.getItem(GROUP_BY_NODE_STORAGE_KEY) !== "false";
}

function storedActiveInstanceId() {
  try {
    return window.localStorage?.getItem(ACTIVE_INSTANCE_STORAGE_KEY)?.trim() || "";
  } catch {
    return "";
  }
}

function persistActiveInstanceId(id: string) {
  try {
    if (id) {
      window.localStorage?.setItem(ACTIVE_INSTANCE_STORAGE_KEY, id);
      return;
    }
    window.localStorage?.removeItem(ACTIVE_INSTANCE_STORAGE_KEY);
  } catch {
    // Storage can be unavailable in privacy-restricted browser contexts.
  }
}

export function useWorkbenchInstances<T extends InstanceBoardItem>({ instances, selection = { mode: "persistent" } }: UseWorkbenchInstancesInput<T>) {
  const persistentSelection = selection.mode === "persistent";
  const activeInstanceId = persistentSelection ? ref(storedActiveInstanceId()) : selection.activeInstanceId;
  const instanceFilter = ref("");
  const instanceSortMode = ref<InstanceListSortMode>("node-asc");
  const groupInstancesByNode = ref(storedGroupByNode());

  const sortedInstances = computed(() => {
    const list = [...(instances.value || [])];
    return list.sort((a, b) => {
      if (instanceSortMode.value === "name-asc") {
        return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
      }
      if (instanceSortMode.value === "node-asc") {
        return nodeLabel(a).localeCompare(nodeLabel(b)) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
      }
      return a.connectionStatus.localeCompare(b.connectionStatus)
        || a.status.localeCompare(b.status)
        || a.name.localeCompare(b.name)
        || a.id.localeCompare(b.id);
    });
  });

  const duplicateInstanceNames = computed(() => {
    const counts = new Map<string, number>();
    for (const instance of instances.value || []) {
      counts.set(instance.name, (counts.get(instance.name) || 0) + 1);
    }
    return new Set([...counts.entries()].filter(([, count]) => count > 1).map(([name]) => name));
  });

  const filteredInstances = computed(() => {
    const term = instanceFilter.value.trim().toLowerCase();
    if (!term) {
      return sortedInstances.value;
    }
    return sortedInstances.value.filter((instance) => {
      const haystack = [instance.name, instance.project?.name, instance.projectId, instance.image?.name, instance.imageSelection?.imageId, nodeLabel(instance), instance.nodeId]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(term);
    });
  });

  const activeInstance = computed(() => sortedInstances.value.find((instance) => instance.id === activeInstanceId.value));

  if (persistentSelection) watch(activeInstanceId, persistActiveInstanceId, { flush: "sync" });

  watch(
    [sortedInstances, () => selection.mode !== "persistent" || selection.directoryComplete?.value !== false],
    ([list, directoryComplete]) => {
      const selectedInstanceMissing = Boolean(activeInstanceId.value)
        && !list.some((instance) => instance.id === activeInstanceId.value);
      if (persistentSelection && (!activeInstanceId.value || (directoryComplete && selectedInstanceMissing)) && list[0]) {
        activeInstanceId.value = list[0].id;
      }
    },
    { immediate: true },
  );

  watch(groupInstancesByNode, (value) => {
    window.localStorage?.setItem(GROUP_BY_NODE_STORAGE_KEY, String(value));
  });

  function instanceDisplayName(instance: InstanceBoardItem) {
    return formatInstanceDisplayName(instance, duplicateInstanceNames.value);
  }

  function selectInstance(id: string) {
    activeInstanceId.value = id;
  }

  return {
    activeInstance,
    activeInstanceId,
    filteredInstances,
    groupInstancesByNode,
    instanceDisplayName,
    instanceFilter,
    instanceSortMode,
    selectInstance,
    sortedInstances,
  };
}
