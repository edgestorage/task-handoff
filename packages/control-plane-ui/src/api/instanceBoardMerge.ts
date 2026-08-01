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

/**
 * TanStack Query applies an observer's structural sharing function both to the
 * cached query value and to values returned by `select`. The instance-board
 * cache stores a payload, while its workbench observer selects the item array,
 * so the merger must preserve both shapes.
 */
export function mergeInstanceBoardQueryData(
  previous: InstanceBoardPayload | InstanceBoardItem[] | undefined,
  incoming: InstanceBoardPayload | InstanceBoardItem[],
): InstanceBoardPayload | InstanceBoardItem[] {
  if (Array.isArray(incoming)) {
    const previousItems = Array.isArray(previous) ? previous : undefined;
    if (!previousItems) return incoming;
    const previousById = new Map(previousItems.map((instance) => [instance.id, instance]));
    return replaceEqualDeep(previousItems, incoming.map((instance) => mergeInstance(previousById.get(instance.id), instance)));
  }
  return mergeInstanceBoardPayload(Array.isArray(previous) ? undefined : previous, incoming);
}
