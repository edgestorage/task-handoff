import type { QueryClient } from "@tanstack/vue-query";
import type { InstanceLifecycleSnapshot } from "@task-handoff/protocol/control-plane";
import type { InstanceBoardItem } from "../../api/types";
import type { ControlPlaneInstanceResourceEntry } from "@task-handoff/control-plane-client";
import { controlPlaneQueryKeys } from "../../api/queryKeys.ts";
import { mergeNewerLifecycleProjection } from "../../api/instanceBoardMerge.ts";
import { updateInstanceBoardData } from "./instanceBoardCache.ts";

export function applyInstanceLifecycle(queryClient: QueryClient, lifecycle: InstanceLifecycleSnapshot) {
  let matched = false;
  const patch = (instance: InstanceBoardItem): InstanceBoardItem => {
    if (instance.id !== lifecycle.instanceId) return instance;
    matched = true;
    if ((instance.stateRevision || 0) >= lifecycle.revision) return instance;
    const imageProvisioning = lifecycle.imageProvisioning ? {
      phase: lifecycle.imageProvisioning.phase,
      requestedReference: lifecycle.imageProvisioning.requestedReference!,
      generation: lifecycle.imageProvisioning.generation,
      error: lifecycle.imageProvisioning.error,
      startedAt: lifecycle.imageProvisioning.startedAt,
      updatedAt: lifecycle.imageProvisioning.updatedAt,
    } : undefined;
    return mergeNewerLifecycleProjection(instance, {
      ...instance,
      stateRevision: lifecycle.revision,
      updatedAt: lifecycle.updatedAt,
      status: lifecycle.status,
      health: lifecycle.health,
      connectionStatus: lifecycle.connectionStatus,
      ready: lifecycle.ready,
      imageProvisioning,
      runtimeVersion: lifecycle.runtimeVersion,
      workspace: lifecycle.workspace,
      lastHeartbeatAt: lifecycle.lastHeartbeatAt,
      access: { ...instance.access, status: lifecycle.accessStatus },
    });
  };
  updateInstanceBoardData(queryClient, (instances) => instances.map(patch));
  queryClient.setQueryData<ControlPlaneInstanceResourceEntry[]>(controlPlaneQueryKeys.instanceDirectory, (current) => current?.map((instance) => {
    if (instance.id !== lifecycle.instanceId) return instance;
    matched = true;
    return {
      ...instance,
      status: lifecycle.status,
      health: lifecycle.health,
      connectionStatus: lifecycle.connectionStatus,
      ready: lifecycle.ready,
      lastHeartbeatAt: lifecycle.lastHeartbeatAt,
      observedAt: lifecycle.updatedAt,
      workspace: { ...instance.workspace, ...lifecycle.workspace },
    };
  }));
  return matched;
}
