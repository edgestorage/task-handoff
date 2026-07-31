import { replaceEqualDeep } from "@tanstack/vue-query";
import type { InstanceBoardItem, InstanceBoardPayload } from "./types";

function mergeInstance(
  previous: InstanceBoardItem | undefined,
  incoming: InstanceBoardItem,
) {
  if (!previous) return incoming;
  if ((previous.stateRevision || 0) <= (incoming.stateRevision || 0)) return incoming;
  return mergeNewerLifecycleProjection(incoming, previous);
}

/**
 * Keeps the HTTP board projection authoritative while preserving lifecycle
 * fields that were advanced by a newer WebSocket snapshot.
 */
export function mergeNewerLifecycleProjection(
  incoming: InstanceBoardItem,
  lifecycle: InstanceBoardItem,
): InstanceBoardItem {
  return {
    ...incoming,
    stateRevision: lifecycle.stateRevision,
    updatedAt: lifecycle.updatedAt,
    status: lifecycle.status,
    health: lifecycle.health,
    connectionStatus: lifecycle.connectionStatus,
    imageProvisioning: lifecycle.imageProvisioning,
    runtimeVersion: lifecycle.runtimeVersion,
    ready: lifecycle.ready,
    workspace: lifecycle.workspace,
    lastHeartbeatAt: lifecycle.lastHeartbeatAt,
    access: { ...incoming.access, status: lifecycle.access.status },
  };
}

export function mergeInstanceBoardPayload(
  previous: InstanceBoardPayload | undefined,
  incoming: InstanceBoardPayload,
): InstanceBoardPayload {
  if (!previous) return incoming;
  const previousById = new Map(previous.data.map((instance) => [instance.id, instance]));
  return replaceEqualDeep(previous, {
    ...incoming,
    data: incoming.data.map((instance) => mergeInstance(previousById.get(instance.id), instance)),
  });
}
