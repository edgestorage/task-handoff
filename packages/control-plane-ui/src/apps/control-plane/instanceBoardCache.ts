import type { QueryClient } from "@tanstack/vue-query";
import type { InstanceBoardItem, InstanceBoardPayload } from "../../api/types";
import { controlPlaneQueryKeys } from "../../api/queryKeys.ts";

export function updateInstanceBoardData(
  queryClient: QueryClient,
  update: (instances: InstanceBoardItem[]) => InstanceBoardItem[],
) {
  queryClient.setQueryData<InstanceBoardPayload>(controlPlaneQueryKeys.instanceBoard, (current) => (
    current ? { ...current, data: update(current.data) } : current
  ));
}
