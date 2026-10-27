import { computed, toValue, type MaybeRefOrGetter } from "vue";
import { useQueries } from "@tanstack/vue-query";
import { nodeControlPlaneTrustQueryOptions, useNodesQuery } from "../../../api/queries";
import type { CloudNodeRelayTrust } from "../../../api/types";
import { nodeControlPlaneTrustProjection } from "./items";

/**
 * The Control Plane proxies the node-agent's authoritative trust snapshot for
 * every visible node. This keeps approval available from any authenticated
 * management connection without persisting a second approvable copy in the CP.
 */
export function useNodeControlPlaneTrustInbox(enabled: MaybeRefOrGetter<boolean> = true) {
  const nodesQuery = useNodesQuery();
  const nodes = computed(() => nodesQuery.data.value || []);
  const managedNodes = computed(() => nodes.value
    .filter((node) => node.connectionEnabled !== false && node.status !== "offline" && node.status !== "unknown"));
  const trustQueries = useQueries({
    queries: () => managedNodes.value.map((node) => nodeControlPlaneTrustQueryOptions(node.id, enabled)),
  });

  const trust = computed<CloudNodeRelayTrust[]>(() => toValue(enabled) ? managedNodes.value.flatMap((node, index) => {
    const snapshot = trustQueries.value[index]?.data;
    if (!snapshot) return [];
    return snapshot.requests
      .filter((request) => request.status === "pending")
      .map((request) => nodeControlPlaneTrustProjection(node, request));
  }) : []);

  async function refetch(nodeId?: string) {
    const queries = managedNodes.value
      .map((node, index) => ({ node, query: trustQueries.value[index] }))
      .filter(({ node, query }) => Boolean(query) && (!nodeId || node.id === nodeId))
      .map(({ query }) => query);
    await Promise.all(queries.map((query) => query.refetch()));
  }

  return { trust, refetch };
}
