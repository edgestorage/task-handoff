import type { TriggerIndex } from "@task-handoff/protocol/triggers";

export function controlledInstanceTriggerSnapshot(index: TriggerIndex) {
  return {
    enabledCount: index.deployments.filter((entry) => entry.enabled).length,
    runningCount: index.runtime.filter((entry) => entry.status === "running").length,
    errorCount: index.runtime.filter((entry) => entry.status === "error").length,
    configs: index.configs.map((config) => ({
      configHash: config.configHash,
      config,
      deployments: index.deployments.filter((entry) => entry.configHash === config.configHash),
      runtime: index.runtime.filter((entry) => entry.configHash === config.configHash),
    })),
    recentRuns: index.recentRuns.slice(0, 20),
  };
}
