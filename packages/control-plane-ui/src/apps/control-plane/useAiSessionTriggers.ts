import { computed, ref } from "vue";
import { useQueryClient } from "@tanstack/vue-query";
import { bindAiSessionTrigger, unbindAiSessionTrigger, useControlPlaneTriggersQuery } from "../../api/queries";
import type { AiSessionSummary, InstanceWithAiSessions } from "../../api/types";
import { isAiSessionTriggerDeployment, removeInstanceTriggerBinding, upsertInstanceTriggerBinding } from "./instanceTriggerCache.ts";

type AiSessionTriggerTarget = {
  instance: InstanceWithAiSessions;
  session: AiSessionSummary;
};

export function useAiSessionTriggers() {
  const queryClient = useQueryClient();
  const triggerBusyKey = ref("");
  const triggers = useControlPlaneTriggersQuery();
  const triggerTemplates = computed(() => triggers.data.value?.triggers || []);

  function boundTriggers(target: AiSessionTriggerTarget) {
    return (target.instance.triggers?.configs || []).flatMap((entry) => entry.deployments.filter((deployment) => isAiSessionTriggerDeployment(deployment, target.session.id)));
  }

  function isTriggerBound(target: AiSessionTriggerTarget, configHash: string) {
    return boundTriggers(target).some((deployment) => deployment.configHash === configHash);
  }

  function triggerActionKey(target: AiSessionTriggerTarget, configHash: string) {
    return `${target.instance.id}:${target.session.id}:${configHash}`;
  }

  async function toggleTrigger(target: AiSessionTriggerTarget, configHash: string) {
    const key = triggerActionKey(target, configHash);
    if (triggerBusyKey.value) return;
    triggerBusyKey.value = key;
    try {
      if (isTriggerBound(target, configHash)) {
        await unbindAiSessionTrigger(target.instance.id, target.session.id, configHash);
        removeInstanceTriggerBinding(queryClient, target.instance.id, target.session.id, configHash);
      } else {
        const created = await bindAiSessionTrigger(target.instance.id, target.session.id, configHash);
        upsertInstanceTriggerBinding(queryClient, target.instance.id, created);
      }
      await queryClient.invalidateQueries({ queryKey: ["control-plane-triggers"] });
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
    triggerTemplates,
  };
}

function shortHash(value: string) {
  return value.length > 14 ? `${value.slice(0, 10)}...` : value;
}
