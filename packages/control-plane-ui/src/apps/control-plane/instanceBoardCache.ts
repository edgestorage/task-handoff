import type { QueryClient } from "@tanstack/vue-query";
import type { InstanceBoardItem, InstanceBoardPayload } from "../../api/types";
import { controlPlaneQueryKeys } from "../../api/queryKeys.ts";
import { mergeInstanceBoardItem } from "../../api/instanceBoardMerge.ts";

export function updateInstanceBoardData(
  queryClient: QueryClient,
  update: (instances: InstanceBoardItem[]) => InstanceBoardItem[],
) {
  queryClient.setQueriesData<InstanceBoardPayload>({ queryKey: controlPlaneQueryKeys.instanceBoard }, (current) => (
    current ? { ...current, data: update(current.data) } : current
  ));
}

export function applyInstanceBoardTargetSnapshot(
  queryClient: QueryClient,
  scopeInstanceId: string,
  targetInstanceId: string,
  incoming: InstanceBoardItem | undefined,
) {
  let applied = false;
  queryClient.setQueryData<InstanceBoardPayload>(
    controlPlaneQueryKeys.scopedInstanceBoard(scopeInstanceId),
    (current) => {
      if (!current) return current;
      const index = current.data.findIndex((instance) => instance.id === targetInstanceId);
      if (!incoming) {
        if (index < 0) return current;
        applied = true;
        return { ...current, data: current.data.filter((instance) => instance.id !== targetInstanceId) };
      }
      applied = true;
      if (index < 0) return { ...current, data: [...current.data, incoming] };
      const data = [...current.data];
      data[index] = mergeInstanceBoardItem(data[index], incoming);
      return { ...current, data };
    },
  );
  return applied;
}
