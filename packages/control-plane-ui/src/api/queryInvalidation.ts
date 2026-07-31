import type { QueryClient } from "@tanstack/vue-query";
import { controlPlaneQueryKeys } from "./queryKeys.ts";

export type ControlPlaneQueryDomain =
  | "manual"
  | "projects"
  | "images"
  | "market"
  | "models"
  | "nodeState"
  | "nodeTopology"
  | "nodeRuntimeState"
  | "nodeFolders"
  | "instances"
  | "chat";

type QueryInvalidator = Pick<QueryClient, "invalidateQueries">;
type QueryKey = readonly unknown[];

const domainQueryKeys: Record<Exclude<ControlPlaneQueryDomain, "manual">, () => QueryKey[]> = {
  projects: () => [
    controlPlaneQueryKeys.projects,
    controlPlaneQueryKeys.instanceBoard,
  ],
  images: () => [
    controlPlaneQueryKeys.images,
    controlPlaneQueryKeys.imageOptions,
    controlPlaneQueryKeys.nodeImageCatalog(),
    controlPlaneQueryKeys.instanceBoard,
  ],
  market: () => [
    controlPlaneQueryKeys.marketCatalog,
    controlPlaneQueryKeys.imageOptions,
    controlPlaneQueryKeys.nodeImageCatalog(),
  ],
  models: () => [controlPlaneQueryKeys.models],
  nodeState: () => [controlPlaneQueryKeys.nodes],
  nodeTopology: () => [
    controlPlaneQueryKeys.nodes,
    controlPlaneQueryKeys.nodeRuntimes,
    controlPlaneQueryKeys.nodeLocalFolders(),
    controlPlaneQueryKeys.nodeImageCatalog(),
    controlPlaneQueryKeys.instanceBoard,
    controlPlaneQueryKeys.models,
  ],
  nodeRuntimeState: () => [
    controlPlaneQueryKeys.nodeRuntimes,
    controlPlaneQueryKeys.instanceBoard,
  ],
  nodeFolders: () => [controlPlaneQueryKeys.nodeLocalFolders()],
  instances: () => [controlPlaneQueryKeys.instanceBoard],
  chat: () => [
    controlPlaneQueryKeys.chatBridges,
    controlPlaneQueryKeys.chatStatus,
  ],
};

const manualOnlyQueryKeys = () => [
  controlPlaneQueryKeys.status,
  controlPlaneQueryKeys.settings,
] as QueryKey[];

/**
 * Resolves semantic data domains to the query prefixes that project them.
 * Prefix keys intentionally invalidate every parameterized query in a domain.
 */
export function controlPlaneDomainQueryKeys(domains: Iterable<ControlPlaneQueryDomain>): QueryKey[] {
  const keys = new Map<string, QueryKey>();
  const add = (queryKey: QueryKey) => keys.set(JSON.stringify(queryKey), queryKey);

  for (const domain of domains) {
    if (domain === "manual") {
      for (const queryKey of manualOnlyQueryKeys()) add(queryKey);
      for (const resolve of Object.values(domainQueryKeys)) {
        for (const queryKey of resolve()) add(queryKey);
      }
      continue;
    }
    for (const queryKey of domainQueryKeys[domain]()) add(queryKey);
  }

  return [...keys.values()];
}

export async function invalidateControlPlaneDomains(
  queryClient: QueryInvalidator,
  domains: Iterable<ControlPlaneQueryDomain>,
) {
  await Promise.all(controlPlaneDomainQueryKeys(domains).map((queryKey) => (
    queryClient.invalidateQueries({ queryKey })
  )));
}
