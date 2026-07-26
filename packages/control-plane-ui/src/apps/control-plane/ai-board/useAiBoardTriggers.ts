import { computed, ref } from "vue";
import { useQueryClient } from "@tanstack/vue-query";
import { bindAiSessionTrigger, unbindAiSessionTrigger, useControlPlaneTriggersQuery } from "../../../api/queries";
import type { InstanceBoardItem, TriggerConfig, TriggerDeployment, TriggerRuntimeState } from "../../../api/types";
import type { AiBoardCard } from "./aiBoardTypes";
import type { Translate } from "../../../i18n/status.ts";

type TriggerMutationResult = {
  config?: TriggerConfig;
  deployment?: TriggerDeployment;
  runtime?: TriggerRuntimeState;
};

type InstanceTriggerSnapshot = NonNullable<InstanceBoardItem["triggers"]>;

export function useAiBoardTriggers(t: Translate) {
  const queryClient = useQueryClient();
  const triggerBusyKey = ref("");
  const triggers = useControlPlaneTriggersQuery();
  const triggerTemplates = computed(() => triggers.data.value?.triggers || []);

  function boundTriggers(card: AiBoardCard) {
    return (card.instance.triggers?.configs || []).flatMap((entry) => entry.deployments.filter((deployment) => isAiSessionTriggerDeployment(deployment, card.session.id)));
  }

  function isTriggerBound(card: AiBoardCard, configHash: string) {
    return boundTriggers(card).some((deployment) => deployment.configHash === configHash);
  }

  function triggerActionKey(card: AiBoardCard, configHash: string) {
    return `${card.instance.id}:${card.session.id}:${configHash}`;
  }

  function triggerButtonTitle(card: AiBoardCard) {
    const count = boundTriggers(card).length;
    return count ? t("sessions.actions.triggersBound", { count }) : t("sessions.actions.addTrigger");
  }

  async function toggleTrigger(card: AiBoardCard, configHash: string) {
    const key = triggerActionKey(card, configHash);
    if (triggerBusyKey.value) {
      return;
    }
    triggerBusyKey.value = key;
    try {
      if (isTriggerBound(card, configHash)) {
        await unbindAiSessionTrigger(card.instance.id, card.session.id, configHash);
        removeLocalTriggerBinding(card, configHash);
      } else {
        const created = await bindAiSessionTrigger(card.instance.id, card.session.id, configHash) as TriggerMutationResult;
        upsertLocalTriggerBinding(card, created);
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["instance-board"] }),
        queryClient.invalidateQueries({ queryKey: ["control-plane-triggers"] }),
      ]);
    } finally {
      triggerBusyKey.value = "";
    }
  }

  return {
    boundTriggers,
    isTriggerBound,
    shortHash,
    toggleTrigger,
    triggerActionKey,
    triggerBusyKey,
    triggerButtonTitle,
    triggerTemplates,
  };

  function upsertLocalTriggerBinding(card: AiBoardCard, result: TriggerMutationResult) {
    if (!result.config || !result.deployment) {
      return;
    }
    queryClient.setQueryData<InstanceBoardItem[]>(["instance-board"], (current = []) => current.map((instance) => {
      if (instance.id !== card.instance.id) {
        return instance;
      }
      const snapshot = instance.triggers || emptyTriggerSnapshot();
      const currentConfig = snapshot.configs.find((entry) => entry.configHash === result.config?.configHash);
      const nextEntry = {
        configHash: result.config.configHash,
        config: result.config,
        deployments: [
          ...(currentConfig?.deployments || []).filter((deployment) => deployment.deploymentId !== result.deployment?.deploymentId),
          result.deployment,
        ],
        runtime: result.runtime
          ? [...(currentConfig?.runtime || []).filter((runtime) => runtime.deploymentId !== result.runtime?.deploymentId), result.runtime]
          : currentConfig?.runtime || [],
      };
      const configs = [
        ...snapshot.configs.filter((entry) => entry.configHash !== result.config?.configHash),
        nextEntry,
      ];
      return {
        ...instance,
        triggers: {
          ...snapshot,
          configs,
          updatedAt: new Date().toISOString(),
        },
      };
    }));
  }

  function removeLocalTriggerBinding(card: AiBoardCard, configHash: string) {
    queryClient.setQueryData<InstanceBoardItem[]>(["instance-board"], (current = []) => current.map((instance) => {
      if (instance.id !== card.instance.id || !instance.triggers) {
        return instance;
      }
      const configs = instance.triggers.configs.flatMap((entry) => {
        if (entry.configHash !== configHash) {
          return [entry];
        }
        const deployments = entry.deployments.filter((deployment) => !isAiSessionTriggerDeployment(deployment, card.session.id));
        if (!deployments.length) {
          return [];
        }
        const deploymentIds = new Set(deployments.map((deployment) => deployment.deploymentId || deployment.configHash));
        return [{
          ...entry,
          deployments,
          runtime: entry.runtime.filter((runtime) => deploymentIds.has(runtime.deploymentId || runtime.configHash)),
        }];
      });
      return {
        ...instance,
        triggers: {
          ...instance.triggers,
          configs,
          updatedAt: new Date().toISOString(),
        },
      };
    }));
  }
}

function isAiSessionTriggerDeployment(deployment: TriggerDeployment, sessionId: string) {
  return deployment.target.type === "ai-session" && deployment.target.aiSessionId === sessionId;
}

function shortHash(value: string) {
  return value.length > 14 ? `${value.slice(0, 10)}...` : value;
}

function emptyTriggerSnapshot(): InstanceTriggerSnapshot {
  return {
    configs: [],
    recentRuns: [],
    updatedAt: new Date().toISOString(),
  };
}
