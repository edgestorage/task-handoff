import type { QueryClient } from "@tanstack/vue-query";
import type { InstanceBoardItem, InstanceTriggerIndex, InstanceTriggerMutationResult, TriggerDeployment } from "../../api/types";
import { markInstanceTriggerProjectionAuthoritative } from "../../api/instanceBoardMerge.ts";
import { updateInstanceBoardData } from "./instanceBoardCache.ts";

type InstanceTriggerSnapshot = NonNullable<InstanceBoardItem["triggers"]>;

export function isAiSessionTriggerDeployment(deployment: TriggerDeployment, sessionId: string) {
  return deployment.target.type === "ai-session" && deployment.target.aiSessionId === sessionId;
}

export function upsertInstanceTriggerBinding(
  queryClient: QueryClient,
  instanceId: string,
  result: InstanceTriggerMutationResult,
) {
  markInstanceTriggerProjectionAuthoritative(instanceId);
  updateInstanceBoardData(queryClient, (instances) => instances.map((instance) => {
    if (instance.id !== instanceId) return instance;
    const snapshot = instance.triggers || emptyTriggerSnapshot();
    const currentConfig = snapshot.configs.find((entry) => entry.configHash === result.config.configHash);
    const deploymentId = result.deployment.deploymentId || result.deployment.configHash;
    const nextEntry = {
      configHash: result.config.configHash,
      config: result.config,
      deployments: [
        ...(currentConfig?.deployments || []).filter((deployment) => (deployment.deploymentId || deployment.configHash) !== deploymentId),
        result.deployment,
      ],
      runtime: result.runtime
        ? [...(currentConfig?.runtime || []).filter((runtime) => (runtime.deploymentId || runtime.configHash) !== deploymentId), result.runtime]
        : currentConfig?.runtime || [],
    };
    return withTriggerSnapshot(instance, {
      ...snapshot,
      configs: [
        ...snapshot.configs.filter((entry) => entry.configHash !== result.config.configHash),
        nextEntry,
      ],
      updatedAt: result.deployment.updatedAt,
    });
  }));
}

export function removeInstanceTriggerBinding(
  queryClient: QueryClient,
  instanceId: string,
  sessionId: string,
  configHash: string,
  observedAt = new Date().toISOString(),
) {
  markInstanceTriggerProjectionAuthoritative(instanceId);
  updateInstanceBoardData(queryClient, (instances) => instances.map((instance) => {
    if (instance.id !== instanceId || !instance.triggers) return instance;
    const configs = instance.triggers.configs.flatMap((entry) => {
      if (entry.configHash !== configHash) return [entry];
      const deployments = entry.deployments.filter((deployment) => !isAiSessionTriggerDeployment(deployment, sessionId));
      if (!deployments.length) return [];
      const deploymentIds = new Set(deployments.map((deployment) => deployment.deploymentId || deployment.configHash));
      return [{
        ...entry,
        deployments,
        runtime: entry.runtime.filter((runtime) => deploymentIds.has(runtime.deploymentId || runtime.configHash)),
      }];
    });
    return withTriggerSnapshot(instance, { ...instance.triggers, configs, updatedAt: observedAt });
  }));
}

export function replaceInstanceTriggerSnapshot(
  queryClient: QueryClient,
  instanceId: string,
  index: InstanceTriggerIndex,
  observedAt = new Date().toISOString(),
) {
  markInstanceTriggerProjectionAuthoritative(instanceId);
  updateInstanceBoardData(queryClient, (instances) => instances.map((instance) => {
    if (instance.id !== instanceId) return instance;
    return withTriggerSnapshot(instance, {
      configs: index.configs.map((config) => ({
        configHash: config.configHash,
        config,
        deployments: index.deployments.filter((deployment) => deployment.configHash === config.configHash),
        runtime: index.runtime.filter((runtime) => runtime.configHash === config.configHash),
      })),
      recentRuns: index.recentRuns,
      updatedAt: observedAt,
    });
  }));
}

function withTriggerSnapshot(instance: InstanceBoardItem, triggers: InstanceTriggerSnapshot): InstanceBoardItem {
  return { ...instance, triggers };
}

function emptyTriggerSnapshot(): InstanceTriggerSnapshot {
  return { configs: [], recentRuns: [], updatedAt: new Date(0).toISOString() };
}
