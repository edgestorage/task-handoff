import type { QueryClient } from "@tanstack/vue-query";
import type { InstanceLifecycleHeartbeat, InstanceLifecycleSnapshot, NodeStateProjectionEvent } from "@task-handoff/protocol/control-plane";
import type { ControlPlaneNodeFleetState } from "@task-handoff/protocol/control-plane-directory";
import type { InstanceBoardItem, InstanceBoardPayload } from "../../api/types";
import type { Node } from "../../api/types";
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
    // The directory entry carries no revision, so the observation clock is the
    // staleness guard: a replayed snapshot must not overwrite a newer board.
    if (instance.observedAt && lifecycle.updatedAt < instance.observedAt) return instance;
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

/**
 * A lifecycle heartbeat only moves the observation timestamps, so it refreshes the
 * heartbeat clock in place and never re-derives the fields a snapshot owns.
 */
export function applyInstanceLifecycleHeartbeat(queryClient: QueryClient, heartbeat: InstanceLifecycleHeartbeat) {
  let matched = false;
  updateInstanceBoardData(queryClient, (instances) => instances.map((instance) => {
    if (instance.id !== heartbeat.instanceId) return instance;
    matched = true;
    if ((instance.stateRevision || 0) >= heartbeat.revision) return instance;
    return {
      ...instance,
      stateRevision: heartbeat.revision,
      updatedAt: heartbeat.updatedAt,
      ...(heartbeat.lastHeartbeatAt === undefined ? {} : { lastHeartbeatAt: heartbeat.lastHeartbeatAt }),
    };
  }));
  queryClient.setQueryData<ControlPlaneInstanceResourceEntry[]>(controlPlaneQueryKeys.instanceDirectory, (current) => current?.map((instance) => {
    if (instance.id !== heartbeat.instanceId) return instance;
    matched = true;
    if (instance.observedAt && heartbeat.updatedAt < instance.observedAt) return instance;
    return {
      ...instance,
      observedAt: heartbeat.updatedAt,
      ...(heartbeat.lastHeartbeatAt === undefined ? {} : { lastHeartbeatAt: heartbeat.lastHeartbeatAt }),
    };
  }));
  return matched;
}

export function applyNodeFleetState(queryClient: QueryClient, state: ControlPlaneNodeFleetState) {
  let applied = false;
  queryClient.setQueriesData<InstanceBoardPayload>({ queryKey: controlPlaneQueryKeys.instanceBoard }, (current) => {
    if (!current?.meta) return current;
    const nodeStates = current.meta.nodeStates || [];
    const index = nodeStates.findIndex((candidate) => candidate.nodeId === state.nodeId && candidate.resource === state.resource);
    const previous = index >= 0 ? nodeStates[index] : undefined;
    if ((previous?.revision ?? -1) > (state.revision ?? -1)) return current;
    const nextNodeStates = [...nodeStates];
    if (index >= 0) nextNodeStates[index] = state;
    else nextNodeStates.push(state);
    const replacedRoutes = new Set([previous?.error?.route, state.error?.route].filter((route): route is string => Boolean(route)));
    const nodeErrors = (current.meta.nodeErrors || []).filter((error) => (
      error.nodeId !== state.nodeId || !replacedRoutes.has(error.route)
    ));
    if (state.error) nodeErrors.push(state.error);
    applied = true;
    return {
      ...current,
      meta: {
        ...current.meta,
        nodeStates: nextNodeStates,
        nodeErrors,
      },
    };
  });
  return applied;
}

export function applyNodeStateProjection(queryClient: QueryClient, state: NodeStateProjectionEvent) {
  let applied = false;
  queryClient.setQueryData<Node[]>(controlPlaneQueryKeys.nodes, (current) => current?.map((node) => {
    if (node.id !== state.nodeId) return node;
    applied = true;
    return {
      ...node,
      status: state.status,
      health: state.health,
      lastSeenAt: state.lastSeenAt ?? undefined,
      connectionPhase: state.connectionPhase ?? undefined,
      connectionDiagnostics: state.connectionDiagnostics ?? undefined,
      proxyState: state.proxyState ?? undefined,
    };
  }));
  return applied;
}
