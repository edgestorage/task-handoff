import type { QueryClient } from "@tanstack/vue-query";
import type { InstanceLifecycleSnapshot } from "@task-handoff/protocol/control-plane";

type BoardInstance = {
  id: string;
  stateRevision: number;
  access: { status: string; [key: string]: unknown };
  [key: string]: unknown;
};

type BoardPayload = {
  data: BoardInstance[];
  meta?: unknown;
};

export function applyInstanceLifecycle(queryClient: QueryClient, lifecycle: InstanceLifecycleSnapshot) {
  let matched = false;
  const patch = (instance: BoardInstance): BoardInstance => {
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
    return {
      ...instance,
      stateRevision: lifecycle.revision,
      updatedAt: lifecycle.updatedAt,
      status: lifecycle.status,
      health: lifecycle.health,
      connectionStatus: lifecycle.connectionStatus,
      imageProvisioning,
      workspace: lifecycle.workspace,
      lastHeartbeatAt: lifecycle.lastHeartbeatAt,
      access: { ...instance.access, status: lifecycle.accessStatus },
    };
  };
  queryClient.setQueryData<BoardInstance[]>(["instance-board"], (current) => current?.map(patch));
  queryClient.setQueryData<BoardPayload>(["instance-board-payload"], (current) => current ? { ...current, data: current.data.map(patch) } : current);
  return matched;
}
